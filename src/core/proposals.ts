// Your decisions on the tasks a split or an answer proposed. They are
// decided one by one, after the task has ended.

import type { Draft } from "./draft";
import type { EndedState, YouInput } from "./types";

type Decision = Extract<YouInput, { kind: "approve_proposals" | "deny_proposals" }>;

export function decideProposals(
  draft: Draft,
  state: EndedState,
  input: Decision,
): string | undefined {
  if (state.proposals.length === 0) return `task ${draft.task.id} has no proposals`;
  if (input.which.length === 0) return "name at least one proposal";
  const seen = new Set<number>();
  for (const index of input.which) {
    const proposal = state.proposals[index];
    if (proposal === undefined) return `there is no proposal ${index}`;
    if (proposal.decision !== "pending") return `proposal ${index} is already ${proposal.decision}`;
    if (seen.has(index)) return `proposal ${index} is named twice`;
    seen.add(index);
  }
  if (input.kind === "deny_proposals") {
    draft.record({ type: "proposals.denied", which: input.which });
    return undefined;
  }
  draft.record({ type: "proposals.approved", which: input.which });
  const approved = state.proposals
    .filter((_, index) => seen.has(index))
    .map((p) => ({ title: p.title, description: p.description }));
  draft.send({ kind: "add_tasks", task: draft.task.id, proposals: approved });
  return undefined;
}
