// Judges one input against one task. It reads as an outline: a new task,
// then a missing task, then outside changes, then the sender, then the
// phase. `docs/core.md` has the rules, under "How every input is judged".

import { evolve } from "./evolve";
import {
  heldWorkspaces,
  holdsSession,
  phaseRole,
  plainBrief,
  runningSession,
  sessionRole,
  stoppingSession,
  waitsOn,
} from "./task";
import type {
  AgentInput,
  Command,
  Config,
  Decision,
  Event,
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
  if (task.state.phase === "ended") return refuse(`task ${task.id} has ended`);
  if (input.sender === "agent") {
    const stranger = notTheAgent(task, input);
    if (stranger !== undefined) return refuse(stranger);
  }
  return refuse("not built yet");
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
      const cleanup: Command[] =
        input.kind === "workspace_created" && !heldWorkspaces(task).includes(input.request)
          ? [{ kind: "remove_workspace", task: task.id, path: input.path }]
          : [];
      return accept(cleanup);
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

function isArrival(input: Input): input is Arrival {
  return (
    (input.sender === "you" && input.kind === "add") ||
    (input.sender === "plugin" && input.kind === "task_arrived")
  );
}

function receive(input: Arrival): Decision {
  const draft = new Draft(undefined, input);
  const source: Source = input.sender === "you" ? { kind: "local", id: input.task } : input.source;
  const overrides = input.sender === "you" ? settingsOf(input) : {};
  draft.record({
    type: "task.received",
    source,
    title: input.title,
    description: input.description,
    overrides,
  });
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

// Only the session the step holds as running is heard, and only for the
// role that works the phase.
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

function accept(commands: Command[]): Decision {
  return { ok: true, events: [], commands };
}

function refuse(reason: string): Decision {
  return { ok: false, reason };
}

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventBody = Without<Event, "v" | "task" | "at">;

// The events and commands of one decision. Each event is applied as it is
// recorded, so the next step of the decision reads the task as it now is.
class Draft {
  readonly events: Event[] = [];
  readonly commands: Command[] = [];
  private broken: string | undefined;

  constructor(
    public task: Task | undefined,
    private readonly input: Input,
  ) {}

  record(body: EventBody): void {
    if (this.broken !== undefined) return;
    const event: Event = { ...body, v: 1, task: this.input.task, at: this.input.at };
    const next = evolve(this.task, event);
    if (!next.ok) {
      this.broken = next.reason;
      return;
    }
    this.task = next.task;
    this.events.push(event);
  }

  send(command: Command): void {
    this.commands.push(command);
  }

  done(): Decision {
    if (this.broken !== undefined) return refuse(`the core made a mistake: ${this.broken}`);
    return { ok: true, events: this.events, commands: this.commands };
  }
}
