// What a task at rest does next. A queued task that isn't held asks for
// what its phase needs: a workspace, then a session.

import type { Draft } from "./draft";
import { branchName, plainBrief } from "./task";
import type { BuildState, Handover, Role, Workspace, WorkspaceRequest } from "./types";

export function advance(draft: Draft): void {
  const state = draft.task.state;
  if (state.phase === "ended" || state.hold !== undefined || state.step.kind !== "queued") return;
  switch (state.phase) {
    case "triage":
      if (state.workspace === undefined) {
        requestWorkspace(draft, { kind: "task", branch: branchName(draft.task) });
      } else {
        requestPlanner(draft, state.workspace);
      }
      return;
    case "build":
      if (state.workspace === undefined) {
        requestWorkspace(draft, { kind: "task", branch: branchName(draft.task) });
      } else if (state.step.kind === "queued" && state.step.handover !== undefined) {
        handOn(draft, state.step.handover, state.workspace);
      } else {
        requestBuilder(draft, state, state.workspace);
      }
      return;
    default:
      return;
  }
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

function requestPlanner(draft: Draft, workspace: Workspace): void {
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
