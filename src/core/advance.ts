// What a task at rest does next. A queued task that isn't held asks for
// what its phase needs: a workspace, then a session.

import type { Draft } from "./draft";
import { branchName, plainBrief } from "./task";
import type {
  ActiveState,
  BuildState,
  Copy,
  Handback,
  Handover,
  ReviewState,
  Role,
  TriageState,
  Workspace,
  WorkspaceRequest,
} from "./types";

export function advance(draft: Draft): void {
  const state = draft.task.state;
  if (state.phase === "ended" || state.hold !== undefined || state.step.kind !== "queued") return;
  switch (state.phase) {
    case "triage":
      if (state.workspace === undefined) {
        requestWorkspace(draft, { kind: "task", branch: branchName(draft.task) });
      } else {
        requestPlanner(draft, state, state.workspace);
      }
      return;
    case "build":
      if (state.workspace === undefined) {
        requestWorkspace(draft, { kind: "task", branch: branchName(draft.task) });
      } else if (
        state.step.kind === "queued" &&
        state.step.handover !== undefined &&
        !isStale(state)
      ) {
        handOn(draft, state.step.handover, state.workspace);
      } else {
        requestBuilder(draft, state, state.workspace);
      }
      return;
    case "review": {
      const copy = state.step.kind === "queued" ? state.step.copy : undefined;
      if (copy === undefined) {
        requestWorkspace(draft, { kind: "copy", commit: state.reviewed.commit });
      } else {
        requestTester(draft, state, copy);
      }
      return;
    }
  }
}

function requestTester(draft: Draft, state: ReviewState, copy: Copy): void {
  const request = draft.nextRequest();
  recordSession(draft, request, "tester", false);
  draft.send({
    kind: "start_session",
    task: draft.task.id,
    request,
    role: "tester",
    path: copy.path,
    edits: false,
    intent: state.intent,
    rigor: state.rigor,
    brief: state.brief,
    ...(state.spec === undefined ? {} : { spec: state.spec }),
    ...(state.lifted === undefined ? {} : { back: state.lifted }),
    review: { commit: state.reviewed.commit, work: state.handover.work },
  });
}

function requestBuilder(draft: Draft, state: BuildState, workspace: Workspace): void {
  const request = draft.nextRequest();
  const edits = state.intent !== "answer";
  const back = state.lifted;
  recordSession(draft, request, "builder", edits);
  draft.send({
    kind: "start_session",
    task: draft.task.id,
    request,
    role: "builder",
    path: workspace.path,
    edits,
    intent: state.intent,
    rigor: state.rigor,
    brief: state.brief,
    ...(state.spec === undefined ? {} : { spec: state.spec }),
    ...(state.handback === undefined ? {} : { handback: state.handback }),
    ...(back === undefined ? {} : { back }),
  });
}

function requestWorkspace(draft: Draft, workspace: WorkspaceRequest): void {
  const request = draft.nextRequest();
  draft.record({ type: "workspace.requested", request, workspace });
  draft.send({ kind: "create_workspace", task: draft.task.id, request, workspace });
}

function requestPlanner(draft: Draft, state: TriageState, workspace: Workspace): void {
  const request = draft.nextRequest();
  recordSession(draft, request, "planner", false);
  draft.send({
    kind: "start_session",
    task: draft.task.id,
    request,
    role: "planner",
    path: workspace.path,
    edits: false,
    brief: plainBrief(draft.task),
    ...(state.lifted === undefined ? {} : { back: state.lifted }),
  });
}

function recordSession(draft: Draft, request: number, role: Role, edits: boolean): void {
  draft.record({ type: "session.requested", request, role, edits });
}

// Handed-over work moves on: an answer goes straight to review on the
// handed-over commit, and the rest merge main first.
function handOn(draft: Draft, handover: Handover, workspace: Workspace): void {
  if (handover.intent === "answer") {
    const reviewed = { commit: handover.commit, files: handover.files };
    draft.record({ type: "phase.started", phase: "review", handover, reviewed });
    advance(draft);
    return;
  }
  const request = draft.nextRequest();
  draft.record({ type: "main.requested", request });
  draft.send({ kind: "merge_main", task: draft.task.id, request, path: workspace.path });
}

// Whether the task's agent or work was made for another intent than the
// task's. Stale work is never merged, reviewed or delivered.
export function isStale(state: ActiveState): boolean {
  const step = state.step;
  switch (state.phase) {
    case "triage":
      return false;
    case "review":
      return state.intent !== state.handover.intent;
    case "build":
      if ((step.kind === "starting" || step.kind === "running") && "intent" in step) {
        return step.intent !== state.intent;
      }
      if ("handover" in step && step.handover !== undefined) {
        return step.handover.intent !== state.intent;
      }
      if ("output" in step) return state.intent !== "try";
      return false;
  }
}

// Whether your overrides end triage: intent and rigor are both set.
export function triageSkipped(state: ActiveState): boolean {
  return (
    state.phase === "triage" &&
    state.overrides.intent !== undefined &&
    state.overrides.rigor !== undefined
  );
}

// Build starts from your overrides, with the title and description as
// brief, as when triage is skipped at add.
export function buildFromOverrides(draft: Draft): void {
  const state = draft.task.state;
  if (state.phase !== "triage" || !triageSkipped(state)) return;
  const { intent, rigor, approve } = state.overrides;
  if (intent === undefined || rigor === undefined) return;
  draft.record({
    type: "phase.started",
    phase: "build",
    intent,
    rigor,
    approve: approve ?? false,
    brief: plainBrief(draft.task),
    loops: 0,
    ...(state.workspace === undefined ? {} : { workspace: state.workspace }),
  });
}

// The task goes back to build, keeping its plan, loops and workspace.
export function backToBuild(
  draft: Draft,
  state: BuildState | ReviewState,
  handback?: Handback,
  loops = state.loops,
): void {
  draft.record({
    type: "phase.started",
    phase: "build",
    intent: state.intent,
    rigor: state.rigor,
    approve: state.approve,
    brief: state.brief,
    ...(state.spec === undefined ? {} : { spec: state.spec }),
    loops,
    ...(state.workspace === undefined ? {} : { workspace: state.workspace }),
    ...(handback === undefined ? {} : { handback }),
  });
}

// A step in flight has settled, and the task still holds its slot. A
// change you made meanwhile applies now, then the task moves on.
export function settled(draft: Draft): void {
  const state = draft.task.state;
  if (state.phase !== "ended" && state.step.kind === "queued") {
    if (triageSkipped(state)) {
      buildFromOverrides(draft);
    } else if (state.phase === "review" && isStale(state)) {
      if (state.step.copy !== undefined) dropCopy(draft, state.step.copy);
      const now = draft.task.state;
      if (now.phase === "review") backToBuild(draft, now);
    }
  }
  advance(draft);
}

function dropCopy(draft: Draft, copy: Copy): void {
  draft.record({ type: "workspace.removed", request: copy.request });
  draft.send({ kind: "remove_workspace", task: draft.task.id, path: copy.path });
}
