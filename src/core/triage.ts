// The planner's calls during triage.

import type { Draft } from "./draft";
import { stopAgent } from "./stop";
import type { AgentInput, TriageState } from "./types";

export function triageCall(
  draft: Draft,
  state: TriageState,
  input: AgentInput,
): string | undefined {
  if (state.question !== undefined) return "the agent's own question is still open";
  switch (input.kind) {
    case "proceed": {
      if (input.brief.trim() === "") return "the brief is empty";
      if (input.rigor === "light" && input.spec !== undefined) return "a light task gets no spec";
      // Your rigor wins. A task that ends up light gets no spec.
      const spec = (state.overrides.rigor ?? input.rigor) === "full" ? input.spec : undefined;
      const call = {
        intent: input.intent,
        rigor: input.rigor,
        approve: input.approve,
        brief: input.brief,
        ...(spec === undefined ? {} : { spec }),
      };
      stopAgent(draft, input.session, "reported", spec !== undefined, spec);
      draft.record({ type: "task.triaged", outcome: { kind: "proceed", ...call } });
      return undefined;
    }
    case "split":
      if (input.proposals.length === 0) return "a split needs at least one proposal";
      stopAgent(draft, input.session, "reported", false);
      draft.record({
        type: "task.triaged",
        outcome: { kind: "split", proposals: input.proposals },
      });
      return undefined;
    case "decline":
      if (input.reason.trim() === "") return "a decline needs a reason";
      stopAgent(draft, input.session, "reported", false);
      draft.record({ type: "task.triaged", outcome: { kind: "decline", reason: input.reason } });
      return undefined;
    default:
      return "not built yet";
  }
}
