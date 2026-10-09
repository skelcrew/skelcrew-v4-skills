// The core's types: a task and its phases, the inputs by sender, the
// events and the commands. `docs/core.md` explains each, and records the
// calls made where the docs were silent.

export type TaskId = string;
// Milliseconds since the epoch. It always comes from the input.
export type Moment = number;

export type Intent = "ship" | "try" | "answer";
export type Rigor = "light" | "full";
export type Role = "planner" | "builder" | "tester";

// Where a task came from, such as the local inbox or a GitHub issue.
export type Source = { kind: string; id: string };

export type Usage = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  minutes: number;
};

// A session is named by the number of the request that started it.
export type SessionRecord = { session: number; role: Role; harnessId: string; usage: Usage };

// The task's worktree. `unsaved` is set when a save in it failed, and
// cleared by the next save that works. An unsaved workspace is never
// removed.
export type Workspace = { request: number; path: string; branch: string; unsaved: boolean };

// The tester's detached copy at the reviewed commit. Never saved.
export type Copy = { request: number; path: string; commit: string };

export type Proposal = { title: string; description: string };
export type Spec = { path: string; text: string };

// What the builder handed over with `done`.
export type Work =
  | { kind: "summary"; text: string }
  | { kind: "report"; text: string; proposals: Proposal[] };

// The handed-over work, fixed when it is handed over. `intent` is the
// intent it was built for. A change of intent makes it stale.
export type Handover = {
  intent: Intent;
  commit: string;
  files: string[];
  by: "builder" | "you";
  work: Work;
};

// The commit that review, approval and delivery all use, and every file
// the branch changed since it left main.
export type Reviewed = { commit: string; files: string[] };

// What the next builder is told about the last round.
export type Handback =
  | { kind: "findings"; text: string }
  | { kind: "denied"; note: string }
  | { kind: "conflict" };

export type Hold =
  | { kind: "paused" }
  // A session lost while no daemon ran has no exit code.
  | { kind: "crashed"; exitCode?: number; lastLine: string }
  | { kind: "gave_up"; reason: string }
  | { kind: "loop_cap"; findings: string }
  | { kind: "failed"; what: "workspace" | "session" | "merge" | "delivery"; error: string }
  | { kind: "unsaved" };

export type Answer = { text: string; by: { kind: "you" } | { kind: "tracker"; account: string } };

// An open question, and your answer once you gave it. The answer is kept
// until a slot is free.
export type Question = { session: number; text: string; options: string[]; answer?: Answer };

// --- Steps ---

export type Queued = { kind: "queued" };
export type CreatingWorkspace = { kind: "creating_workspace"; request: number };
export type Starting = { kind: "starting"; request: number };
export type Running = { kind: "running"; session: number };
// Why a session ends: its agent reported (done, a verdict, a triage call or
// giving up), Skelcrew stopped it (pause, kill, a change of intent), or it
// crashed. The stop saves its work in every case.
export type EndReason = "reported" | "stopped" | "crashed";

export type Stopping = { kind: "stopping"; session: number; reason: EndReason };
// The last steps carry the output to hand over, and whether its changes
// touch a critical path.
export type Last = { output: Output; critical: boolean };
// The output waits to be delivered. A task is here only while it is held.
export type Ready = Last & { kind: "ready" };
export type AwaitingApproval = Last & { kind: "awaiting_approval" };
export type Delivering = Last & { kind: "delivering"; request: number };
export type LastStep = Ready | AwaitingApproval | Delivering;

export type TriageStep =
  | Queued
  | CreatingWorkspace
  | Starting
  | Running
  | (Stopping & { proceed?: Proceed });

// A builder's session holds the intent it was started for. A change of
// intent restarts it.
export type BuildStep =
  | (Queued & { handover?: Handover })
  | CreatingWorkspace
  | (Starting & { intent: Intent })
  | (Running & { intent: Intent })
  | (Stopping & { handover?: Handover })
  | { kind: "merging"; request: number; handover: Handover }
  | LastStep;

export type Verdict = { kind: "pass"; evidence: string } | { kind: "changes"; findings: string };

export type ReviewStep =
  | (Queued & { copy?: Copy })
  | CreatingWorkspace
  | (Starting & { copy: Copy })
  | (Running & { copy: Copy })
  | (Stopping & { copy: Copy; verdict?: Verdict })
  | LastStep;

// --- Phases ---

// What a task can have on top of its phase.
export type Sides = {
  question?: Question;
  hold?: Hold;
  // The hold last lifted, kept until the next session starts. It puts the
  // task first in the queue, and tells the new session why it is back.
  lifted?: Hold;
  attached: boolean;
};

// Your calls during triage. Each wins over the planner's for its field.
export type Overrides = { intent?: Intent; rigor?: Rigor; approve?: boolean };

// The planner's call to proceed.
export type Proceed = {
  intent: Intent;
  rigor: Rigor;
  approve: boolean;
  brief: string;
  spec?: Spec;
};

export type TriageState = Sides & {
  phase: "triage";
  overrides: Overrides;
  workspace?: Workspace;
  step: TriageStep;
};

// What build and review share: triage's outcome, and the loops so far.
export type Plan = {
  intent: Intent;
  rigor: Rigor;
  approve: boolean;
  brief: string;
  spec?: Spec;
  loops: number;
};

export type BuildState = Sides &
  Plan & {
    phase: "build";
    workspace?: Workspace;
    handback?: Handback;
    step: BuildStep;
  };

export type ReviewState = Sides &
  Plan & {
    phase: "review";
    workspace: Workspace;
    handover: Handover;
    reviewed: Reviewed;
    step: ReviewStep;
  };

export type Output =
  | {
      kind: "branch";
      branch: string;
      commit: string;
      mergeable: boolean;
      summary: string;
      evidence?: string;
    }
  | { kind: "report"; commit: string; report: string; evidence: string };

export type Outcome =
  | { kind: "done"; output: Output }
  | { kind: "split" }
  | { kind: "declined"; reason: string }
  | { kind: "killed" }
  | { kind: "failed" };

export type ProposalState = Proposal & { decision: "pending" | "approved" | "denied" };

// An agent an ended task still waits on: a start still in flight, which
// is stopped once it answers, or a stop not yet confirmed.
export type Leftover =
  | { kind: "starting"; request: number }
  | { kind: "stopping"; session: number; reason: EndReason };

// An ended task. `agent` is the agent it still waits on. `workspace` and
// `copy` are what that agent runs in, removed once its stop is saved. A
// workspace whose save failed stays for good.
export type EndedState = {
  phase: "ended";
  outcome: Outcome;
  proposals: ProposalState[];
  agent?: Leftover;
  workspace?: Workspace;
  copy?: Copy;
};

export type PhaseState = TriageState | BuildState | ReviewState | EndedState;
export type ActiveState = TriageState | BuildState | ReviewState;

export type Task = {
  id: TaskId;
  source: Source;
  title: string;
  description: string;
  receivedAt: Moment;
  // The last request number used. The next request takes one more.
  requests: number;
  sessions: SessionRecord[];
  state: PhaseState;
};

// --- Inputs ---

type Envelope = { task: TaskId; at: Moment };

export type Settings = { intent?: Intent; rigor?: Rigor; approve?: boolean };

export type YouInput = Envelope & { sender: "you" } & (
    | ({ kind: "add"; title: string; description: string } & Settings)
    | ({ kind: "set" } & Settings)
    | { kind: "reply"; text: string }
    | { kind: "approve" }
    | { kind: "deny"; note: string }
    | { kind: "approve_proposals"; which: number[] }
    | { kind: "deny_proposals"; which: number[] }
    | { kind: "attach" }
    | { kind: "detach"; choice: "resume" }
    | { kind: "detach"; choice: "hand_over"; commit: string; files: string[] }
    | { kind: "pause" }
    | { kind: "resume" }
    | { kind: "start" }
    | { kind: "retry" }
    | { kind: "kill" }
  );

export type AgentInput = Envelope & { sender: "agent"; session: number; role: Role } & (
    | ({ kind: "proceed" } & Proceed)
    | { kind: "split"; proposals: Proposal[] }
    | { kind: "decline"; reason: string }
    | { kind: "ask"; text: string; options: string[] }
    | { kind: "give_up"; reason: string }
    | { kind: "progress"; text: string }
    | { kind: "done"; commit: string; files: string[]; work: Work }
    | { kind: "pass"; evidence: string }
    | { kind: "changes"; findings: string }
  );

export type SaveResult = "saved" | "nothing" | "failed";

export type PluginInput = Envelope & { sender: "plugin" } & (
    | { kind: "task_arrived"; source: Source; title: string; description: string }
    | { kind: "outside_change"; change: "closed" | "reopened" | "relabelled" }
    | { kind: "tracker_reply"; account: string; text: string }
    | { kind: "workspace_created"; request: number; path: string }
    | { kind: "workspace_failed"; request: number; error: string }
    | { kind: "session_started"; request: number; harnessId: string }
    | { kind: "session_failed"; request: number; error: string }
    | { kind: "session_ended"; session: number; exitCode?: number; lastLine: string }
    | { kind: "session_stopped"; session: number; save: SaveResult }
    | { kind: "main_merged"; request: number; commit: string; files: string[] }
    | { kind: "main_conflict"; request: number }
    | { kind: "main_failed"; request: number; error: string }
    | { kind: "output_delivered"; request: number }
    | { kind: "output_failed"; request: number; error: string }
  );

export type DaemonInput = Envelope & { sender: "daemon" } & (
    | { kind: "start" }
    | { kind: "deliver_answer" }
    | { kind: "usage"; session: number; usage: Usage }
  );

export type Input = YouInput | AgentInput | PluginInput | DaemonInput;

// --- Events ---

type Stamp = { v: 1; task: TaskId; at: Moment };

export type TriageOutcome =
  | ({ kind: "proceed" } & Proceed)
  | { kind: "split"; proposals: Proposal[] }
  | { kind: "decline"; reason: string };

export type WorkspaceRequest = { kind: "task"; branch: string } | { kind: "copy"; commit: string };

export type BuildStart = Plan & {
  phase: "build";
  workspace?: Workspace;
  handback?: Handback;
};

export type Event = Stamp &
  (
    | {
        type: "task.received";
        source: Source;
        title: string;
        description: string;
        overrides: Overrides;
      }
    | { type: "task.triaged"; outcome: TriageOutcome }
    | ({ type: "task.set" } & Settings)
    | ({ type: "phase.started" } & BuildStart)
    | { type: "phase.started"; phase: "review"; handover: Handover; reviewed: Reviewed }
    | { type: "workspace.requested"; request: number; workspace: WorkspaceRequest }
    | { type: "workspace.created"; request: number; path: string }
    | { type: "workspace.failed"; request: number; error: string }
    | { type: "workspace.removed"; request: number }
    | { type: "session.requested"; request: number; role: Role; edits: boolean }
    | { type: "session.started"; session: number; harnessId: string }
    | { type: "session.failed"; request: number; error: string }
    | { type: "session.stopping"; session: number; save: boolean; reason: EndReason }
    | { type: "session.ended"; session: number; reason: EndReason; save: SaveResult }
    | { type: "question.asked"; session: number; text: string; options: string[] }
    | { type: "question.answered"; answer: Answer }
    | { type: "answer.delivered" }
    | { type: "session.attached" }
    | { type: "session.detached"; choice: "resume" | "hand_over" }
    | { type: "task.paused" }
    | { type: "task.resumed"; via: "resume" | "retry" }
    | { type: "task.started" }
    | { type: "progress.reported"; session: number; text: string }
    | { type: "build.done"; handover: Handover }
    | { type: "main.requested"; request: number }
    | { type: "main.merged"; request: number; commit: string; files: string[] }
    | { type: "main.conflict"; request: number }
    | { type: "main.failed"; request: number; error: string }
    | { type: "review.passed"; session: number; evidence: string }
    | { type: "review.changes_requested"; session: number; findings: string }
    | ({ type: "output.ready" } & Last)
    | { type: "approval.requested" }
    | { type: "approval.given" }
    | { type: "approval.denied"; note: string }
    | { type: "proposals.approved"; which: number[] }
    | { type: "proposals.denied"; which: number[] }
    | { type: "output.requested"; request: number }
    | { type: "output.delivered"; request: number }
    | { type: "output.failed"; request: number; error: string }
    | { type: "task.held"; hold: Hold }
    | { type: "task.killed" }
    | { type: "task.failed" }
    | { type: "usage.reported"; session: number; usage: Usage }
  );

export type EventType = Event["type"];

// --- Commands ---

export type Command =
  | { kind: "create_workspace"; task: TaskId; request: number; workspace: WorkspaceRequest }
  | { kind: "remove_workspace"; task: TaskId; path: string; deleteBranch?: string }
  | {
      kind: "start_session";
      task: TaskId;
      request: number;
      role: Role;
      path: string;
      edits: boolean;
      intent?: Intent;
      rigor?: Rigor;
      brief: string;
      spec?: Spec;
      handback?: Handback;
      back?: Hold;
      review?: { commit: string; work: Work };
    }
  | { kind: "stop_session"; task: TaskId; session: number; save: boolean; write?: Spec }
  | { kind: "type_into_session"; task: TaskId; session: number; text: string }
  | { kind: "merge_main"; task: TaskId; request: number; path: string }
  | { kind: "deliver_output"; task: TaskId; request: number; output: Output }
  | { kind: "add_tasks"; task: TaskId; proposals: Proposal[] };

// --- Config and results ---

export type Config = {
  maxRunning: number;
  // Glob patterns. A change to a matching file needs your sign-off.
  critical: string[];
  // Tracker accounts whose replies count as yours.
  accounts: string[];
};

export const LOOP_CAP = 3;

export type Decision =
  | { ok: true; events: Event[]; commands: Command[] }
  | { ok: false; reason: string };

export type Evolved = { ok: true; task: Task } | { ok: false; reason: string };
