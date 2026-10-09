// Stopping an agent, and what follows once the stop is confirmed.

import { advance } from "./advance";
import type { Draft } from "./draft";
import type { EndReason, PluginInput, Spec } from "./types";

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
export function stopped(
  draft: Draft,
  input: Extract<PluginInput, { kind: "session_stopped" }>,
): void {
  const before = draft.task.state;
  if (before.phase === "ended" || before.step.kind !== "stopping") return;
  draft.record({
    type: "session.ended",
    session: input.session,
    reason: before.step.reason,
    save: input.save,
  });
  if (input.save === "failed") draft.record({ type: "task.held", hold: { kind: "unsaved" } });
  if (before.phase === "triage" && "proceed" in before.step && before.step.proceed !== undefined) {
    const call = before.step.proceed;
    const yours = before.overrides;
    draft.record({
      type: "phase.started",
      phase: "build",
      intent: yours.intent ?? call.intent,
      rigor: yours.rigor ?? call.rigor,
      approve: yours.approve ?? call.approve,
      brief: call.brief,
      ...(call.spec === undefined ? {} : { spec: call.spec }),
      loops: 0,
      ...(before.workspace === undefined ? {} : { workspace: before.workspace }),
    });
  }
  advance(draft);
}
