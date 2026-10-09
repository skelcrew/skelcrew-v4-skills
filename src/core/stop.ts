// Stopping an agent, and what follows once the stop is confirmed.

import { advance } from "./advance";
import type { Draft } from "./draft";
import { afterTester } from "./review";
import type { EndReason, PluginInput, Spec } from "./types";

type Stopped = Extract<PluginInput, { kind: "session_stopped" }>;

// Lets the agent go. The task keeps its slot until the stop is confirmed.
export function stopAgent(
  draft: Draft,
  session: number,
  reason: EndReason,
  save: boolean,
  write?: Spec,
): void {
  draft.record({ type: "session.stopping", session, save, reason });
  draft.send({
    kind: "stop_session",
    task: draft.task.id,
    session,
    save,
    ...(write === undefined ? {} : { write }),
  });
}

// The stop the task waits on is confirmed. The session ends, and the task
// moves on to whatever the agent's report decided.
export function stopped(draft: Draft, input: Stopped): void {
  const before = draft.task.state;
  if (before.phase === "ended") {
    endedStopped(draft, input);
    return;
  }
  if (before.step.kind !== "stopping") return;
  draft.record({
    type: "session.ended",
    session: input.session,
    reason: before.step.reason,
    save: input.save,
  });
  if (input.save === "failed") draft.record({ type: "task.held", hold: { kind: "unsaved" } });
  const after = draft.task.state;
  if (before.phase === "triage" && "proceed" in before.step && before.step.proceed !== undefined) {
    const call = before.step.proceed;
    const yours = before.overrides;
    const workspace = after.phase === "triage" ? after.workspace : undefined;
    draft.record({
      type: "phase.started",
      phase: "build",
      intent: yours.intent ?? call.intent,
      rigor: yours.rigor ?? call.rigor,
      approve: yours.approve ?? call.approve,
      brief: call.brief,
      ...(call.spec === undefined ? {} : { spec: call.spec }),
      loops: 0,
      ...(workspace === undefined ? {} : { workspace }),
    });
  }
  if (before.phase === "review" && before.step.kind === "stopping") {
    afterTester(draft, before.step.verdict);
    return;
  }
  advance(draft);
}

// An ended task's last agent has stopped. What it ran in is removed now,
// unless its work couldn't be saved. A split or decline deletes the branch
// too.
function endedStopped(draft: Draft, input: Stopped): void {
  const before = draft.task.state;
  if (before.phase !== "ended" || before.agent?.kind !== "stopping") return;
  draft.record({
    type: "session.ended",
    session: input.session,
    reason: before.agent.reason,
    save: input.save,
  });
  const after = draft.task.state;
  if (after.phase !== "ended") return;
  if (after.copy !== undefined) removeWorkspace(draft, after.copy.request, after.copy.path);
  if (after.workspace !== undefined && !after.workspace.unsaved) {
    const branch = after.outcome.kind === "split" || after.outcome.kind === "declined";
    removeWorkspace(
      draft,
      after.workspace.request,
      after.workspace.path,
      branch ? after.workspace.branch : undefined,
    );
  }
}

export function removeWorkspace(
  draft: Draft,
  request: number,
  path: string,
  deleteBranch?: string,
): void {
  draft.record({ type: "workspace.removed", request });
  draft.send({
    kind: "remove_workspace",
    task: draft.task.id,
    path,
    ...(deleteBranch === undefined ? {} : { deleteBranch }),
  });
}
