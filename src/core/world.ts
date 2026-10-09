// A model of the outside world for the property tests. It plays the
// tools: it carries out the core's commands, and offers every reply a real
// tool could give, old ones included, so late and repeated replies come
// up all the time. It records which workspaces and sessions really exist,
// so the tests can check that the core tracks every one.

import { decide } from "./decide";
import { evolve } from "./evolve";
import type {
  Command,
  Config,
  Decision,
  Event,
  Input,
  PluginInput,
  SaveResult,
  Task,
  TaskId,
} from "./types";

type Body<T> = T extends unknown ? Omit<T, "sender" | "task" | "at"> : never;
export type ReplyBody = Body<PluginInput>;
export type Reply = { task: TaskId; body: ReplyBody };

export type Step = {
  input: Input;
  before: Task | undefined;
  after: Task | undefined;
  decision: Decision;
};

type LiveSession = { task: TaskId; session: number; path: string; role: string; stopped: boolean };

const saves: SaveResult[] = ["saved", "nothing", "failed"];
const unsavable: SaveResult[] = ["nothing"];

export class World {
  readonly tasks = new Map<TaskId, Task>();
  readonly log = new Map<TaskId, Event[]>();
  readonly sent: Command[] = [];
  // Workspaces that exist, by path.
  readonly workspaces = new Map<string, TaskId>();
  // Sessions that exist, by `task:session`. `stopped` is set once a stop
  // has reached it. The session is gone once the stop's reply is given.
  readonly sessions = new Map<string, LiveSession>();
  // Paths whose last save failed.
  readonly unsaved = new Set<string>();
  // Every reply a tool could give, in the order offered.
  readonly replies: Reply[] = [];
  private readonly stopsSent = new Set<string>();
  private readonly savingStops = new Set<string>();
  // The outcome each request got, by `task:group:number`. A tool may repeat
  // an outcome, but never contradicts it: a start that failed never also
  // starts.
  private readonly outcomes = new Map<string, string>();
  private readonly gone = new Set<string>();
  private moment = 0;

  constructor(readonly config: Config) {}

  now(): number {
    this.moment += 1_000;
    return this.moment;
  }

  // Whether a reply fits the outcome its request already got.
  fits(task: TaskId, body: ReplyBody): boolean {
    const key = outcomeKey(task, body);
    if (key === undefined) return true;
    const outcome = this.outcomes.get(key);
    return outcome === undefined || outcome === outcomeOf(body);
  }

  // What decide would say, without playing it.
  judge(input: Input): Decision {
    return decide(this.tasks.get(input.task), input, this.config);
  }

  play(input: Input): Step {
    const before = this.tasks.get(input.task);
    const decision = decide(before, input, this.config);
    this.observe(input);
    if (decision.ok) {
      let task = before;
      for (const event of decision.events) {
        const next = evolve(task, event);
        if (!next.ok) throw new Error(`evolve refused ${event.type}: ${next.reason}`);
        task = next.task;
      }
      if (task !== undefined) this.tasks.set(input.task, task);
      const log = this.log.get(input.task) ?? [];
      log.push(...decision.events);
      this.log.set(input.task, log);
      for (const command of decision.commands) this.carryOut(command);
    }
    return { input, before, after: this.tasks.get(input.task), decision };
  }

  startOf(task: TaskId, request: number): Extract<Command, { kind: "start_session" }> | undefined {
    for (const command of this.sent) {
      if (
        command.kind === "start_session" &&
        command.task === task &&
        command.request === request
      ) {
        return command;
      }
    }
    return undefined;
  }

  // What a reply tells the world about itself. A tool gives a reply only
  // once its work is done, so the world changes when the reply is given.
  private observe(input: Input): void {
    if (input.sender !== "plugin") return;
    const key = outcomeKey(input.task, input);
    if (key !== undefined && !this.outcomes.has(key)) this.outcomes.set(key, outcomeOf(input));
    switch (input.kind) {
      case "workspace_created":
        this.workspaces.set(input.path, input.task);
        return;
      case "session_started": {
        const key = `${input.task}:${input.request}`;
        const start = this.startOf(input.task, input.request);
        if (start === undefined || this.gone.has(key) || this.sessions.has(key)) return;
        this.sessions.set(key, {
          task: input.task,
          session: input.request,
          path: start.path,
          role: start.role,
          stopped: this.stopsSent.has(key),
        });
        return;
      }
      case "session_stopped": {
        const key = `${input.task}:${input.session}`;
        if (this.gone.has(key)) return;
        this.gone.add(key);
        this.sessions.delete(key);
        const start = this.startOf(input.task, input.session);
        // Only a stop that saves touches the workspace's work.
        if (start === undefined || !this.savingStops.has(key)) return;
        if (input.save === "failed") this.unsaved.add(start.path);
        else this.unsaved.delete(start.path);
        return;
      }
      default:
        return;
    }
  }

  private carryOut(command: Command): void {
    this.sent.push(command);
    const task = command.task;
    switch (command.kind) {
      case "create_workspace": {
        const path = `/w/${task}/${command.request}`;
        this.offer(task, { kind: "workspace_created", request: command.request, path });
        this.offer(task, {
          kind: "workspace_failed",
          request: command.request,
          error: "disk full",
        });
        return;
      }
      case "remove_workspace":
        this.workspaces.delete(command.path);
        return;
      case "start_session":
        this.offer(task, {
          kind: "session_started",
          request: command.request,
          harnessId: `h${command.request}`,
        });
        this.offer(task, { kind: "session_failed", request: command.request, error: "no tmux" });
        this.offer(task, {
          kind: "session_ended",
          session: command.request,
          exitCode: 1,
          lastLine: "panic",
        });
        return;
      case "stop_session": {
        const key = `${task}:${command.session}`;
        this.stopsSent.add(key);
        if (command.save) this.savingStops.add(key);
        const session = this.sessions.get(key);
        if (session !== undefined) session.stopped = true;
        for (const save of command.save ? saves : unsavable) {
          this.offer(task, { kind: "session_stopped", session: command.session, save });
        }
        return;
      }
      case "merge_main":
        this.offer(task, {
          kind: "main_merged",
          request: command.request,
          commit: `m${command.request}`,
          files: command.request % 3 === 0 ? ["src/auth/token.ts"] : ["src/export.ts"],
        });
        this.offer(task, { kind: "main_conflict", request: command.request });
        this.offer(task, { kind: "main_failed", request: command.request, error: "lock" });
        return;
      case "deliver_output":
        this.offer(task, { kind: "output_delivered", request: command.request });
        this.offer(task, { kind: "output_failed", request: command.request, error: "down" });
        return;
      default:
        return;
    }
  }

  private offer(task: TaskId, body: ReplyBody): void {
    this.replies.push({ task, body });
  }
}

// Replies that answer the same request, grouped, so each request gets one
// outcome. A crash report is not an outcome of the start: a session can
// start and then crash.
function outcomeKey(task: TaskId, body: ReplyBody): string | undefined {
  switch (body.kind) {
    case "workspace_created":
    case "workspace_failed":
      return `${task}:workspace:${body.request}`;
    case "session_started":
    case "session_failed":
      return `${task}:start:${body.request}`;
    case "session_stopped":
      return `${task}:stop:${body.session}`;
    case "main_merged":
    case "main_conflict":
    case "main_failed":
      return `${task}:merge:${body.request}`;
    case "output_delivered":
    case "output_failed":
      return `${task}:output:${body.request}`;
    default:
      return undefined;
  }
}

function outcomeOf(body: ReplyBody): string {
  return body.kind === "session_stopped" ? `stopped:${body.save}` : body.kind;
}
