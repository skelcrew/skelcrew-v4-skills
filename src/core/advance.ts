// What a task at rest does next. A queued task that isn't held asks for
// what its phase needs: a workspace, then a session.

import type { Draft } from "./draft";
import { branchName, plainBrief } from "./task";
import type { Role, Workspace, WorkspaceRequest } from "./types";

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
    default:
      return;
  }
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
