// Judges one input against one task. It reads as an outline: a new task,
// then a missing task, then outside changes, then late replies, then an
// ended task, then the sender, then the phase. `docs/core.md` has the
// rules, under "How every input is judged".

import { advance } from "./advance";
import { accept, Draft, refuse, stamp } from "./draft";
import { evolve } from "./evolve";
import { stopped } from "./stop";
import {
  heldPaths,
  heldWorkspaces,
  holdsSession,
  holdText,
  phaseRole,
  plainBrief,
  runningSession,
  sessionRole,
  stoppingSession,
  waitsOn,
} from "./task";
import { triageCall } from "./triage";
import type {
  ActiveState,
  AgentInput,
  Command,
  Config,
  DaemonInput,
  Decision,
  EndedState,
  Input,
  PluginInput,
  Source,
  Task,
  YouInput,
} from "./types";

type Arrival = Extract<YouInput, { kind: "add" }> | Extract<PluginInput, { kind: "task_arrived" }>;

export function decide(task: Task | undefined, input: Input, _config: Config): Decision {
  if (isArrival(input)) {
    return task === undefined ? receive(input) : refuse(`task ${input.task} already exists`);
  }
  if (task === undefined) return refuse(`there is no task ${input.task}`);
  if (input.sender === "plugin" && input.kind === "outside_change") {
    return refuse(
      `the issue was ${input.change} in the tracker, but tasks move only through Skelcrew`,
    );
  }
  if (input.sender === "plugin") {
    const late = lateReply(task, input);
    if (late !== undefined) return late;
  }
  const draft = new Draft(task, input);
  const state = task.state;
  const refusal =
    state.phase === "ended" ? judgeEnded(draft, state, input) : judge(draft, state, input);
  return refusal === undefined ? draft.done() : refuse(refusal);
}

// An ended task takes only what cleans up after it, usage, and your
// decisions on its proposals. Late replies were handled before.
function judgeEnded(draft: Draft, _state: EndedState, input: Input): string | undefined {
  const ended = `task ${draft.task.id} has ended`;
  switch (input.sender) {
    case "plugin":
      return input.kind === "session_started" ||
        input.kind === "session_failed" ||
        input.kind === "session_ended" ||
        input.kind === "session_stopped"
        ? "not built yet"
        : ended;
    case "daemon":
      return input.kind === "usage" ? "not built yet" : ended;
    case "you":
      return input.kind === "approve_proposals" || input.kind === "deny_proposals"
        ? "not built yet"
        : ended;
    default:
      return ended;
  }
}

// Judges an input against a task that hasn't ended. Returns the reason
// when it is refused.
function judge(draft: Draft, state: ActiveState, input: Input): string | undefined {
  switch (input.sender) {
    case "agent":
      return notTheAgent(draft.task, input) ?? fromAgent(draft, state, input);
    case "daemon":
      return fromDaemon(draft, state, input);
    case "plugin":
      return reply(draft, input);
    default:
      return "not built yet";
  }
}

function fromAgent(draft: Draft, state: ActiveState, input: AgentInput): string | undefined {
  switch (state.phase) {
    case "triage":
      return triageCall(draft, state, input);
    default:
      return "not built yet";
  }
}

function fromDaemon(draft: Draft, state: ActiveState, input: DaemonInput): string | undefined {
  switch (input.kind) {
    case "start":
      if (state.hold !== undefined) return `task ${draft.task.id} is held: ${holdText(state.hold)}`;
      if (state.step.kind !== "queued") return `task ${draft.task.id} isn't waiting for a slot`;
      advance(draft);
      return undefined;
    default:
      return "not built yet";
  }
}

// A reply the task waits on. Late replies never get here.
function reply(draft: Draft, input: PluginInput): string | undefined {
  switch (input.kind) {
    case "workspace_created":
      draft.record({ type: "workspace.created", request: input.request, path: input.path });
      advance(draft);
      return undefined;
    case "workspace_failed":
      draft.record({ type: "workspace.failed", request: input.request, error: input.error });
      draft.record({
        type: "task.held",
        hold: { kind: "failed", what: "workspace", error: input.error },
      });
      return undefined;
    case "session_started":
      draft.record({ type: "session.started", session: input.request, harnessId: input.harnessId });
      return undefined;
    case "session_failed":
      draft.record({ type: "session.failed", request: input.request, error: input.error });
      draft.record({
        type: "task.held",
        hold: { kind: "failed", what: "session", error: input.error },
      });
      return undefined;
    case "session_stopped":
      stopped(draft, input);
      return undefined;
    case "session_ended":
      // The stop in flight will answer for this session.
      if (stoppingSession(draft.task) === input.session) return undefined;
      return "not built yet";
    default:
      return "not built yet";
  }
}

function isArrival(input: Input): input is Arrival {
  return (
    (input.sender === "you" && input.kind === "add") ||
    (input.sender === "plugin" && input.kind === "task_arrived")
  );
}

function receive(input: Arrival): Decision {
  const source: Source = input.sender === "you" ? { kind: "local", id: input.task } : input.source;
  const overrides = input.sender === "you" ? settingsOf(input) : {};
  const received = stamp(
    {
      type: "task.received",
      source,
      title: input.title,
      description: input.description,
      overrides,
    },
    input,
  );
  const created = evolve(undefined, received);
  if (!created.ok) return refuse(`the core made a mistake: ${created.reason}`);
  const draft = new Draft(created.task, input, [received]);
  if (overrides.intent !== undefined && overrides.rigor !== undefined) {
    draft.record({
      type: "phase.started",
      phase: "build",
      intent: overrides.intent,
      rigor: overrides.rigor,
      approve: overrides.approve ?? false,
      brief: plainBrief(input),
      loops: 0,
    });
  }
  return draft.done();
}

// A reply the task no longer waits on is late. It is accepted with only
// the commands that clean up after it. A repeat of what the task already
// holds is accepted and does nothing. Returns undefined for a reply the
// task does wait on, and for every input that isn't a reply.
function lateReply(task: Task, input: PluginInput): Decision | undefined {
  switch (input.kind) {
    case "workspace_created":
    case "workspace_failed": {
      if (waitsOn(task, "creating_workspace", input.request)) return undefined;
      const stray =
        input.kind === "workspace_created" &&
        !heldWorkspaces(task).includes(input.request) &&
        !heldPaths(task).includes(input.path);
      return accept(stray ? [{ kind: "remove_workspace", task: task.id, path: input.path }] : []);
    }
    case "session_started":
    case "session_failed": {
      if (waitsOn(task, "starting", input.request)) return undefined;
      const cleanup: Command[] =
        input.kind === "session_started" && !holdsSession(task, input.request)
          ? [{ kind: "stop_session", task: task.id, session: input.request, save: false }]
          : [];
      return accept(cleanup);
    }
    case "session_ended":
      if (holdsSession(task, input.session) || waitsOn(task, "starting", input.session)) {
        return undefined;
      }
      return accept([]);
    case "session_stopped":
      return stoppingSession(task) === input.session ? undefined : accept([]);
    case "main_merged":
    case "main_conflict":
    case "main_failed":
      return waitsOn(task, "merging", input.request) ? undefined : accept([]);
    case "output_delivered":
    case "output_failed":
      return waitsOn(task, "delivering", input.request) ? undefined : accept([]);
    default:
      return undefined;
  }
}

// Only the session the step holds as running is heard, and only for the
// role it was started for, which must work the phase.
function notTheAgent(task: Task, input: AgentInput): string | undefined {
  if (runningSession(task) !== input.session) {
    return `session ${input.session} isn't the task's agent`;
  }
  const role = sessionRole(task, input.session);
  if (role !== input.role) return `session ${input.session} is the ${role}, not the ${input.role}`;
  if (phaseRole(task) !== role) return `a ${role} doesn't work in ${task.state.phase}`;
  return undefined;
}

function settingsOf(input: Extract<YouInput, { kind: "add" }>) {
  return {
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.rigor === undefined ? {} : { rigor: input.rigor }),
    ...(input.approve === undefined ? {} : { approve: input.approve }),
  };
}
