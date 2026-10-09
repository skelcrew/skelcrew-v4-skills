// Property tests for the rules in `docs/invariants.md`. Random input
// sequences run through the core and a model of the world, and every rule
// is checked after every step. `docs/core.md` lists how each rule is
// checked, under "How each invariant is checked".

import { expect, test } from "bun:test";
import fc from "fast-check";
import { candidates, isBackward } from "./candidates";
import { evolve } from "./evolve";
import { holdsSlot, slotsInUse } from "./schedule";
import { heldPaths, holdsSession, runningSession, stoppingSession } from "./task";
import {
  type Config,
  type Event,
  type EventType,
  type Input,
  LOOP_CAP,
  type Output,
  type Task,
} from "./types";
import { type Step, World } from "./world";

const config: Config = { maxRunning: 2, critical: ["src/auth/**"], accounts: ["me"] };

// Your decisions. No agent, plugin or daemon input may record one.
const yours: EventType[] = [
  "task.set",
  "approval.given",
  "approval.denied",
  "proposals.approved",
  "proposals.denied",
  "task.paused",
  "task.resumed",
  "task.started",
  "task.killed",
  "task.failed",
  "question.answered",
  "session.attached",
  "session.detached",
];

// What an ended task may still record.
const cleanup: EventType[] = [
  "session.started",
  "session.failed",
  "session.stopping",
  "session.ended",
  "workspace.removed",
  "usage.reported",
  "proposals.approved",
  "proposals.denied",
];

const requests = ["create_workspace", "start_session", "merge_main", "deliver_output"];

// Checks every rule after one step. Returns what broke, or undefined.
function broken(world: World, step: Step): string | undefined {
  const { input, before, after, decision } = step;
  const events = decision.ok ? decision.events : [];
  const commands = decision.ok ? decision.commands : [];
  const types = events.map((e) => e.type);

  // 1. Only you decide.
  if (input.sender !== "you") {
    const taken = types.filter((t) => yours.includes(t));
    const trackerAnswer =
      input.sender === "plugin" &&
      input.kind === "tracker_reply" &&
      config.accounts.includes(input.account);
    if (taken.length > 0 && !(trackerAnswer && taken.every((t) => t === "question.answered"))) {
      return `rule 1: ${input.sender} ${input.kind} recorded ${taken.join(", ")}`;
    }
  }

  // 2. Only the task's current agent is heard.
  if (input.sender === "agent" && decision.ok && before !== undefined) {
    if (runningSession(before) !== input.session) {
      return `rule 2: session ${input.session} was heard, but isn't running`;
    }
    const role = before.sessions.find((s) => s.session === input.session)?.role;
    const fits = { triage: "planner", build: "builder", review: "tester", ended: undefined };
    if (role !== input.role || fits[before.state.phase] !== role) {
      return `rule 2: a ${input.role} was heard in ${before.state.phase}`;
    }
  }

  // 13. At most one open question per task: an ask is heard only when none
  // is open.
  if (input.sender === "agent" && input.kind === "ask" && decision.ok) {
    if (before?.state.phase !== "ended" && before?.state.question !== undefined) {
      return "rule 13: a second question was asked while one was open";
    }
  }

  // 3. Proposed tasks never enter the queue without you.
  if (commands.some((c) => c.kind === "add_tasks") && !types.includes("proposals.approved")) {
    return "rule 3: tasks were added without proposals.approved";
  }
  const arrival =
    (input.sender === "you" && input.kind === "add") ||
    (input.sender === "plugin" && input.kind === "task_arrived");
  if (types.includes("task.received") && !arrival) {
    return `rule 3: ${input.kind} received a task`;
  }

  // 4. Outside changes are requests.
  if (input.sender === "plugin" && input.kind === "outside_change" && decision.ok) {
    return "rule 4: an outside change was accepted";
  }

  // 5. A late reply records nothing, and only cleans up.
  if (decision.ok && events.length === 0) {
    const stray = commands.filter(
      (c) => c.kind !== "remove_workspace" && c.kind !== "stop_session",
    );
    if (stray.length > 0) return `rule 5: an input with no events sent ${stray[0]?.kind}`;
  }

  // 6, 7, 8 and 9. What is delivered is exactly what passed review, and
  // flagged or critical work waited for your sign-off.
  for (const command of commands) {
    if (command.kind !== "deliver_output") continue;
    const problem = badDelivery(world, command.task, command.output, after);
    if (problem !== undefined) return problem;
  }

  // 6. Review starts on the merged commit for ship, and on the handed-over
  // one for answer.
  for (const event of events) {
    if (event.type !== "phase.started" || event.phase !== "review") continue;
    const log = world.log.get(event.task) ?? [];
    const merge = log.findLast((e) => e.type === "main.merged");
    const expected =
      event.handover.intent === "answer"
        ? event.handover.commit
        : merge?.type === "main.merged"
          ? merge.commit
          : undefined;
    if (event.reviewed.commit !== expected) return "rule 6: review started on the wrong commit";
  }

  // 12. Reaching the loop cap holds the task.
  if (after !== undefined && before !== undefined && after.state.phase !== "ended") {
    const loops = (task: Task) =>
      task.state.phase === "build" || task.state.phase === "review" ? task.state.loops : 0;
    if (
      loops(after) > loops(before) &&
      loops(after) >= LOOP_CAP &&
      after.state.hold === undefined
    ) {
      return "rule 12: the loop cap was reached without holding the task";
    }
  }

  // 9. Intent sets hard limits.
  for (const command of commands) {
    if (command.kind !== "start_session" || !command.edits) continue;
    if (command.role !== "builder" || command.intent === "answer") {
      return `rule 9: a ${command.role} on ${command.intent} started with edits`;
    }
  }

  // 10. The next agent starts only once the last one's stop is confirmed.
  for (const command of commands) {
    if (command.kind !== "start_session") continue;
    for (const session of world.sessions.values()) {
      if (session.task === command.task && session.session !== command.request) {
        return `rule 10: session ${command.request} started while ${session.session} lives`;
      }
    }
  }

  if (after !== undefined && after.state.phase !== "ended") {
    const state = after.state;
    // 11. A held task has no agent at work, and sends no request.
    if (state.hold !== undefined) {
      if (state.step.kind === "running") return "rule 11: a held task has a running session";
      const sent = commands.filter((c) => requests.includes(c.kind));
      if (sent.length > 0) return `rule 11: a held task sent ${sent[0]?.kind}`;
    }
    // You are attached only to a running session.
    if (state.attached && state.step.kind !== "running") {
      return "you are attached, but no session is running";
    }
    // 20. No question outlives its agent.
    if (state.question !== undefined && state.question.session !== runningSession(after)) {
      return "rule 20: a question outlived its agent";
    }
  }

  // 12. Every failure holds the task.
  const failures = ["workspace_failed", "session_failed", "main_failed", "output_failed"];
  if (input.sender === "plugin" && failures.includes(input.kind) && events.length > 0) {
    const state = after?.state;
    if (state === undefined || (state.phase !== "ended" && state.hold === undefined)) {
      return `rule 12: ${input.kind} didn't hold the task`;
    }
  }

  // 12 and 15. A save that failed holds the task, or keeps the workspace
  // of a task that ended.
  if (input.sender === "plugin" && input.kind === "session_stopped" && input.save === "failed") {
    const state = after?.state;
    if (
      events.length > 0 &&
      state !== undefined &&
      state.phase !== "ended" &&
      state.hold === undefined
    ) {
      return "rule 15: a failed save didn't hold the task";
    }
  }

  // 19. A session that ends without reporting holds the task, with its
  // exit code and last line. Giving up holds it with the reason.
  const afterState = after?.state;
  if (
    decision.ok &&
    events.length > 0 &&
    afterState !== undefined &&
    afterState.phase !== "ended"
  ) {
    const hold = afterState.hold;
    if (input.sender === "plugin" && input.kind === "session_ended") {
      const exitCode = input.exitCode === undefined ? {} : { exitCode: input.exitCode };
      if (!Bun.deepEquals(hold, { kind: "crashed", ...exitCode, lastLine: input.lastLine })) {
        return "rule 19: a crash didn't hold the task with its exit code and last line";
      }
    }
    if (input.sender === "agent" && input.kind === "give_up") {
      if (!Bun.deepEquals(hold, { kind: "gave_up", reason: input.reason })) {
        return "rule 12: giving up didn't hold the task with the reason";
      }
    }
  }

  // 14. No workspace or session is left untracked, both ways.
  for (const [path, owner] of world.workspaces) {
    const task = world.tasks.get(owner);
    if (task === undefined || !heldPaths(task).includes(path)) {
      return `rule 14: workspace ${path} exists but ${owner} doesn't hold it`;
    }
  }
  for (const session of world.sessions.values()) {
    if (session.stopped) continue;
    const task = world.tasks.get(session.task);
    if (task === undefined || !holdsSession(task, session.session)) {
      return `rule 14: session ${session.task}:${session.session} lives but isn't held`;
    }
  }
  for (const task of world.tasks.values()) {
    for (const path of heldPaths(task)) {
      if (!world.workspaces.has(path)) return `rule 14: ${task.id} holds ${path}, which is gone`;
    }
    const state = task.state;
    if (state.phase === "ended" && state.agent === undefined) {
      if (state.copy !== undefined) return `rule 14: ended ${task.id} still holds its copy`;
      if (state.workspace !== undefined && !state.workspace.unsaved) {
        return `rule 14: ended ${task.id} never removed its workspace`;
      }
    }
    const running = runningSession(task);
    if (running !== undefined) {
      const live = world.sessions.get(`${task.id}:${running}`);
      if (live === undefined || live.stopped) {
        return `rule 14: ${task.id} runs session ${running}, which isn't live`;
      }
    }
  }

  // 15. Work is saved before it is let go. A builder that could edit is
  // stopped with a save. Cleanup stops for late sessions record no events,
  // and the late session never worked for the task.
  for (const command of commands) {
    if (command.kind === "stop_session") {
      const start = world.startOf(command.task, command.session);
      if (start?.role === "tester" && command.save) return "rule 15: a tester's stop saved";
      if (start?.edits === true && !command.save && events.length > 0) {
        return `rule 15: builder ${command.session} could edit, but its stop didn't save`;
      }
    }
    if (command.kind !== "remove_workspace") continue;
    if (world.unsaved.has(command.path)) return `rule 15: unsaved ${command.path} was removed`;
    for (const session of world.sessions.values()) {
      if (session.path === command.path) {
        return `rule 15: ${command.path} was removed under session ${session.session}`;
      }
    }
  }

  // 18. Nothing leaves an ending.
  if (before?.state.phase === "ended") {
    const left = types.filter((t) => !cleanup.includes(t));
    if (left.length > 0) return `rule 18: an ended task recorded ${left.join(", ")}`;
  }

  // 22. Replaying the log rebuilds every task exactly.
  if (after !== undefined) {
    // Replay reads the log as the store would save it.
    const saved: Event[] = JSON.parse(JSON.stringify(world.log.get(after.id) ?? []));
    const replayed = replay(saved);
    if (!Bun.deepEquals(replayed, after, true)) return `rule 22: replay of ${after.id} differs`;
  }
  return undefined;
}

function badDelivery(
  world: World,
  id: string,
  output: Output,
  task: Task | undefined,
): string | undefined {
  const state = task?.state;
  if (state === undefined || state.phase === "ended" || state.phase === "triage") {
    return "rule 6: a delivery went out from outside build and review";
  }
  const log = world.log.get(id) ?? [];
  const lastIndex = (type: EventType) => log.findLastIndex((event) => event.type === type);
  if (state.intent === "try") {
    if (output.kind !== "branch" || output.mergeable)
      return "rule 9: a try was delivered as mergeable";
  }
  // The tester that passed last worked in a copy at the delivered commit.
  if (state.phase === "review") {
    if (output.commit !== state.reviewed.commit)
      return "rule 6: the delivered commit isn't the reviewed one";
    const pass = log.findLast((event) => event.type === "review.passed");
    if (pass?.type !== "review.passed") return "rule 7: delivered without review.passed";
    const tester = world.startOf(id, pass.session);
    const copy = world.sent.find(
      (c) =>
        c.kind === "create_workspace" && c.task === id && tester?.path === `/w/${id}/${c.request}`,
    );
    if (copy?.kind !== "create_workspace" || copy.workspace.kind !== "copy") {
      return "rule 7: the tester that passed had no copy";
    }
    if (copy.workspace.commit !== output.commit) return "rule 6: review checked another commit";
  } else if (state.intent === "ship" || state.intent === "answer") {
    return `rule 7: ${state.intent} was delivered from build`;
  } else {
    // A try delivers the commit its last merge gave.
    const merge = log.findLast((event) => event.type === "main.merged");
    if (merge?.type !== "main.merged" || merge.commit !== output.commit) {
      return "rule 6: a try delivered a commit its merge didn't give";
    }
  }
  // 8. Sign-off after the last pass, or the last handover for try.
  const merge = log.findLast((event) => event.type === "main.merged");
  const files =
    state.phase === "review"
      ? state.reviewed.files
      : merge?.type === "main.merged"
        ? merge.files
        : [];
  const critical = files.some((file) =>
    config.critical.some((pattern) => new Bun.Glob(pattern).match(file)),
  );
  if (state.approve || critical) {
    const after = state.phase === "review" ? lastIndex("review.passed") : lastIndex("build.done");
    if (lastIndex("approval.given") < after) return "rule 8: delivered without your sign-off";
  }
  return undefined;
}

// 10. Skelcrew never puts more than max_running to work on its own. Only
// your start or attach goes past it.
// A stop in flight holds a slot, so nothing new starts while it finishes.
// But a stop is cleanup, not putting an agent to work, so a task whose
// agent is being stopped may take a slot back past the limit.
function slotsBroken(world: World, step: Step, before: Set<string>): string | undefined {
  const tasks = [...world.tasks.values()];
  const after = slotsInUse(tasks);
  if (after <= config.maxRunning) return undefined;
  const { input } = step;
  if (input.sender === "you" && (input.kind === "start" || input.kind === "attach"))
    return undefined;
  const added = tasks.filter((task) => holdsSlot(task) && !before.has(task.id));
  if (added.every((task) => stoppingSession(task) !== undefined)) return undefined;
  return `rule 10: ${after} slots in use after ${input.sender} ${input.kind}, past ${config.maxRunning}`;
}

// 21. Usage never goes down.
function usageOf(world: World): Map<string, number> {
  const totals = new Map<string, number>();
  for (const task of world.tasks.values()) {
    for (const { session, usage } of task.sessions) {
      totals.set(`${task.id}:${session}`, usage.input + usage.output + usage.cacheRead);
    }
  }
  return totals;
}

function usageBroken(world: World, before: Map<string, number>): string | undefined {
  for (const [key, total] of usageOf(world)) {
    if (total < (before.get(key) ?? 0)) return `rule 21: usage of ${key} went down`;
  }
  return undefined;
}

// A task carries exactly its phase's and step's fields. v3 once moved
// phase by spreading the old task, and carried old fields into the new
// phase. Each entry lists the fields always there, then those that may be.
type Shape = [string[], string[]];
const sides = ["question", "hold", "lifted"];
const plan = ["intent", "rigor", "approve", "brief", "loops"];
const phases: Record<string, Shape> = {
  triage: [
    ["phase", "overrides", "step", "attached"],
    ["workspace", ...sides],
  ],
  build: [
    ["phase", ...plan, "step", "attached"],
    ["spec", "workspace", "handback", ...sides],
  ],
  review: [
    ["phase", ...plan, "workspace", "handover", "reviewed", "step", "attached"],
    ["spec", ...sides],
  ],
  ended: [
    ["phase", "outcome", "proposals"],
    ["agent", "workspace", "copy"],
  ],
};
const last: Shape = [["kind", "output", "critical", "signed"], []];
const steps: Record<string, Shape> = {
  "triage queued": [["kind"], []],
  "triage creating_workspace": [["kind", "request"], []],
  "triage starting": [["kind", "request"], []],
  "triage running": [["kind", "session"], []],
  "triage stopping": [["kind", "session", "reason", "save"], ["proceed"]],
  "build queued": [["kind"], ["handover"]],
  "build creating_workspace": [["kind", "request"], []],
  "build starting": [["kind", "request", "intent"], []],
  "build running": [["kind", "session", "intent"], []],
  "build stopping": [["kind", "session", "reason", "save"], ["handover"]],
  "build merging": [["kind", "request", "handover"], []],
  "review queued": [["kind"], ["copy"]],
  "review creating_workspace": [["kind", "request"], []],
  "review starting": [["kind", "request", "copy"], []],
  "review running": [["kind", "session", "copy"], []],
  "review stopping": [["kind", "session", "reason", "save", "copy"], ["verdict"]],
};
for (const phase of ["build", "review"]) {
  steps[`${phase} ready`] = last;
  steps[`${phase} awaiting_approval`] = last;
  steps[`${phase} delivering`] = [[...last[0], "request"], []];
}

function misshapen(name: string, value: object, [always, maybe]: Shape): string | undefined {
  const keys = Object.keys(value);
  const extra = keys.filter((key) => !always.includes(key) && !maybe.includes(key));
  const missing = always.filter((key) => !keys.includes(key));
  if (extra.length > 0) return `${name} carries ${extra.join(", ")}`;
  if (missing.length > 0) return `${name} lacks ${missing.join(", ")}`;
  return undefined;
}

function shapeBroken(world: World): string | undefined {
  for (const task of world.tasks.values()) {
    const state = task.state;
    const phase = phases[state.phase];
    if (phase === undefined) return `shape: ${task.id} is in an unknown phase`;
    const problem = misshapen(`${task.id} in ${state.phase}`, state, phase);
    if (problem !== undefined) return `shape: ${problem}`;
    if (state.phase === "ended") continue;
    const name = `${state.phase} ${state.step.kind}`;
    const step = steps[name];
    if (step === undefined) return `shape: ${task.id} has no step ${name}`;
    const stepProblem = misshapen(`${task.id}'s step ${name}`, state.step, step);
    if (stepProblem !== undefined) return `shape: ${stepProblem}`;
  }
  return undefined;
}

function replay(events: Event[]): Task | undefined {
  let task: Task | undefined;
  for (const event of events) {
    const next = evolve(task, event);
    if (!next.ok) return undefined;
    task = next.task;
  }
  return task;
}

// Plays one random run, guided by the choices. Out of eight picks:
// - one is any reply a tool ever offered, so late and repeated replies come up;
// - one is any input at all;
// - one is any input the core accepts, backward ones included;
// - five are accepted inputs that move a task forward.
function run(choices: number[], seen?: Set<EventType>): string | undefined {
  const world = new World(config);
  const trail: string[] = [];
  for (let i = 0; i + 1 < choices.length; i += 2) {
    const mode = (choices[i] ?? 0) % 8;
    const pick = choices[i + 1] ?? 0;
    const all = candidates(world);
    const pool = poolFor(world, mode, all);
    const input = pool[pick % pool.length];
    if (input === undefined) continue;
    const slotsBefore = new Set([...world.tasks.values()].filter(holdsSlot).map((t) => t.id));
    const usageBefore = usageOf(world);
    const step = world.play(input);
    if (seen !== undefined && step.decision.ok) {
      for (const event of step.decision.events) seen.add(event.type);
    }
    trail.push(describe(step));
    const problem =
      broken(world, step) ??
      slotsBroken(world, step, slotsBefore) ??
      usageBroken(world, usageBefore) ??
      shapeBroken(world);
    if (problem !== undefined) {
      return `step ${i / 2}, ${input.sender} ${input.kind}: ${problem}\n${trail.slice(-12).join("\n")}`;
    }
  }
  return undefined;
}

// One line per step, for the report when a rule breaks.
function describe(step: Step): string {
  const { input, decision } = step;
  const { sender: _, at: __, ...body } = input;
  const result = decision.ok
    ? `${decision.events.map((e) => e.type).join(" ")} | ${decision.commands.map((c) => c.kind).join(" ")}`
    : `refused: ${decision.reason}`;
  return `  ${JSON.stringify(body)} -> ${result}`;
}

function poolFor(world: World, mode: number, all: Input[]): Input[] {
  if (mode === 0) {
    const replies = all.filter((input) => input.sender === "plugin" && isReply(input.kind));
    return replies.length > 0 ? replies : all;
  }
  if (mode === 1) return all;
  const accepted = all.filter((input) => {
    const decision = world.judge(input);
    return decision.ok && decision.events.length > 0;
  });
  const forward = mode === 2 ? accepted : accepted.filter((input) => !isBackward(world, input));
  return forward.length > 0 ? forward : all;
}

function isReply(kind: string): boolean {
  return !["task_arrived", "outside_change", "tracker_reply"].includes(kind);
}

// SKELCREW_PROPERTY_RUNS asks for a deeper run than the 300 each check
// makes, such as 5000 before calling a part done.
const deepRuns = Number(process.env.SKELCREW_PROPERTY_RUNS ?? 300) || 300;

const runs = fc.array(fc.nat(), { minLength: 100, maxLength: 400 });

test("every rule holds after every step of random runs", () => {
  fc.assert(
    fc.property(runs, (choices) => {
      const problem = run(choices);
      if (problem !== undefined) throw new Error(problem);
    }),
    { numRuns: deepRuns, includeErrorInReport: true, endOnFailure: true },
  );
}, 120_000);

test("random runs reach every event built so far", () => {
  const seen = new Set<EventType>();
  fc.assert(
    fc.property(runs, (choices) => run(choices, seen) === undefined),
    { numRuns: 600, seed: 42 },
  );
  const reached: EventType[] = [
    "task.received",
    "phase.started",
    "task.triaged",
    "workspace.requested",
    "workspace.created",
    "workspace.failed",
    "workspace.removed",
    "session.requested",
    "session.started",
    "session.failed",
    "session.stopping",
    "session.ended",
    "task.held",
    "proposals.approved",
    "proposals.denied",
    "progress.reported",
    "build.done",
    "main.requested",
    "main.merged",
    "main.conflict",
    "main.failed",
    "review.passed",
    "review.changes_requested",
    "output.ready",
    "approval.requested",
    "approval.given",
    "approval.denied",
    "output.requested",
    "output.delivered",
    "output.failed",
    "task.paused",
    "task.resumed",
    "task.killed",
    "task.failed",
    "session.attached",
    "session.detached",
    "question.asked",
    "question.answered",
    "answer.delivered",
    "task.set",
    "task.started",
    "usage.reported",
  ];
  expect(reached.filter((type) => !seen.has(type))).toEqual([]);
}, 120_000);
