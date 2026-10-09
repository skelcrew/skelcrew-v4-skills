// The tester's verdict, and what follows once the tester has stopped.

import { advance, backToBuild, isStale } from "./advance";
import { outputOf, ready } from "./delivery";
import type { Draft } from "./draft";
import { removeWorkspace, stopAgent } from "./stop";
import { type AgentInput, LOOP_CAP, type ReviewState, type Verdict } from "./types";

export function testerCall(
  draft: Draft,
  state: ReviewState,
  input: AgentInput,
): string | undefined {
  switch (input.kind) {
    case "pass":
      if (state.question !== undefined) return "the agent's own question is still open";
      if (input.evidence.trim() === "") return "a pass needs evidence";
      stopAgent(draft, input.session, "reported", false);
      draft.record({ type: "review.passed", session: input.session, evidence: input.evidence });
      return undefined;
    case "changes":
      if (state.question !== undefined) return "the agent's own question is still open";
      if (input.findings.trim() === "") return "changes need findings";
      stopAgent(draft, input.session, "reported", false);
      draft.record({
        type: "review.changes_requested",
        session: input.session,
        findings: input.findings,
      });
      return undefined;
    default:
      return "not built yet";
  }
}

// The tester has stopped. Its copy goes, then the verdict decides what
// comes next. `verdict` is read from the step before the stop ended.
export function afterTester(draft: Draft, verdict: Verdict | undefined): void {
  const state = draft.task.state;
  if (state.phase !== "review" || state.step.kind !== "queued") return;
  const copy = state.step.copy;
  if (copy !== undefined) removeWorkspace(draft, copy.request, copy.path);
  if (isStale(state)) {
    // Your change of intent sets this review aside, whatever its verdict.
    backToBuild(draft, state);
    advance(draft);
    return;
  }
  if (verdict?.kind === "pass") {
    const output = outputOf(
      state.workspace.branch,
      state.handover,
      state.reviewed,
      verdict.evidence,
    );
    ready(draft, output, state.reviewed.files, state.approve);
    return;
  }
  if (verdict?.kind === "changes") {
    const loops = state.loops + 1;
    backToBuild(draft, state, { kind: "findings", text: verdict.findings }, loops);
    if (loops >= LOOP_CAP) {
      draft.record({ type: "task.held", hold: { kind: "loop_cap", findings: verdict.findings } });
    }
  }
  advance(draft);
}
