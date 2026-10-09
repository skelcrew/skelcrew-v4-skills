// Approval and delivery: the last steps of review, or of build for `try`.

import { backToBuild, isStale } from "./advance";
import type { Draft } from "./draft";
import { removeWorkspace } from "./stop";
import type { ActiveState, Handover, Output, PluginInput, Reviewed } from "./types";

// What the task hands over, at exactly the reviewed commit. `try` is
// never mergeable.
export function outputOf(
  branch: string,
  handover: Handover,
  reviewed: Reviewed,
  evidence?: string,
): Output {
  if (handover.work.kind === "report") {
    return {
      kind: "report",
      commit: reviewed.commit,
      report: handover.work.text,
      evidence: evidence ?? "",
    };
  }
  return {
    kind: "branch",
    branch,
    commit: reviewed.commit,
    mergeable: handover.intent === "ship",
    summary: handover.work.text,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

// The output is ready. It waits for your sign-off if the task has the
// approval flag or its changes touch a critical path, and is delivered
// otherwise, unless the task is held.
export function ready(draft: Draft, output: Output, files: string[], approve: boolean): void {
  const critical = files.some((file) =>
    draft.config.critical.some((pattern) => new Bun.Glob(pattern).match(file)),
  );
  draft.record({ type: "output.ready", output, critical });
  if (approve || critical) {
    draft.record({ type: "approval.requested" });
    return;
  }
  deliver(draft);
}

// Hands the ready output over, unless the task is held.
export function deliver(draft: Draft): void {
  const state = draft.task.state;
  if (state.phase === "ended" || state.hold !== undefined || state.step.kind !== "ready") return;
  const request = draft.nextRequest();
  const output = state.step.output;
  draft.record({ type: "output.requested", request });
  draft.send({ kind: "deliver_output", task: draft.task.id, request, output });
}

export function approve(draft: Draft, state: ActiveState): string | undefined {
  if (state.step.kind !== "awaiting_approval") {
    return `task ${draft.task.id} isn't waiting for your approval`;
  }
  draft.record({ type: "approval.given" });
  deliver(draft);
  return undefined;
}

// Your denial sends the task back to build with your note. It doesn't
// count as a loop, since it isn't a failure.
export function deny(draft: Draft, state: ActiveState, note: string): string | undefined {
  if (state.step.kind !== "awaiting_approval" || state.phase === "triage") {
    return `task ${draft.task.id} isn't waiting for your approval`;
  }
  if (note.trim() === "") return "a denial needs a note for the builder";
  draft.record({ type: "approval.denied", note });
  backToBuild(draft, state, { kind: "denied", note });
  return undefined;
}

type DeliveryReply = Extract<PluginInput, { kind: "output_delivered" | "output_failed" }>;

export function delivered(draft: Draft, input: DeliveryReply): void {
  if (input.kind === "output_failed") {
    draft.record({ type: "output.failed", request: input.request, error: input.error });
    draft.record({
      type: "task.held",
      hold: { kind: "failed", what: "delivery", error: input.error },
    });
    // A change of intent made during the delivery applies now.
    const state = draft.task.state;
    if (state.phase !== "ended" && state.phase !== "triage" && isStale(state)) {
      backToBuild(draft, state);
    }
    return;
  }
  draft.record({ type: "output.delivered", request: input.request });
  const state = draft.task.state;
  if (state.phase === "ended" && state.workspace !== undefined && !state.workspace.unsaved) {
    removeWorkspace(draft, state.workspace.request, state.workspace.path);
  }
}
