// Property tests for the rules in `docs/invariants.md`. Random input
// sequences run through the core and a model of the world, and every rule
// is checked after every step. `docs/core.md` lists how each rule is
// checked, under "How each invariant is checked".

import { expect, test } from "bun:test";
import fc from "fast-check";
import { candidates, isBackward } from "./candidates";
import { evolve } from "./evolve";
import { heldPaths, holdsSession, runningSession } from "./task";
import type { Config, Event, EventType, Input, Task } from "./types";
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
];

// What an ended task may still record.
const cleanup: EventType[] = [
  "session.started",
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
    const running = runningSession(task);
    if (running !== undefined) {
      const live = world.sessions.get(`${task.id}:${running}`);
      if (live === undefined || live.stopped) {
        return `rule 14: ${task.id} runs session ${running}, which isn't live`;
      }
    }
  }

  // 15. Work is saved before it is let go.
  for (const command of commands) {
    if (command.kind === "stop_session") {
      const start = world.startOf(command.task, command.session);
      if (start?.role === "tester" && command.save) return "rule 15: a tester's stop saved";
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
    const replayed = replay(world.log.get(after.id) ?? []);
    if (!Bun.deepEquals(replayed, after, true)) return `rule 22: replay of ${after.id} differs`;
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
  for (let i = 0; i + 1 < choices.length; i += 2) {
    const mode = (choices[i] ?? 0) % 8;
    const pick = choices[i + 1] ?? 0;
    const all = candidates(world);
    const pool = poolFor(world, mode, all);
    const input = pool[pick % pool.length];
    if (input === undefined) continue;
    const step = world.play(input);
    if (seen !== undefined && step.decision.ok) {
      for (const event of step.decision.events) seen.add(event.type);
    }
    const problem = broken(world, step);
    if (problem !== undefined) return `step ${i / 2}, ${input.sender} ${input.kind}: ${problem}`;
  }
  return undefined;
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
  const forward = mode === 2 ? accepted : accepted.filter((input) => !isBackward(input));
  return forward.length > 0 ? forward : all;
}

function isReply(kind: string): boolean {
  return !["task_arrived", "outside_change", "tracker_reply"].includes(kind);
}

const runs = fc.array(fc.nat(), { minLength: 20, maxLength: 160 });

test("every rule holds after every step of random runs", () => {
  fc.assert(
    fc.property(runs, (choices) => {
      const problem = run(choices);
      if (problem !== undefined) throw new Error(problem);
    }),
    { numRuns: 300 },
  );
});

test("random runs reach every event built so far", () => {
  const seen = new Set<EventType>();
  fc.assert(
    fc.property(runs, (choices) => run(choices, seen) === undefined),
    { numRuns: 200, seed: 42 },
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
  ];
  expect(reached.filter((type) => !seen.has(type))).toEqual([]);
});
