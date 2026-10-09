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
      const call = {
        intent: input.intent,
        rigor: input.rigor,
        approve: input.approve,
        brief: input.brief,
        ...(input.spec === undefined ? {} : { spec: input.spec }),
      };
      stopAgent(draft, input.session, "reported", input.spec !== undefined, input.spec);
      draft.record({ type: "task.triaged", outcome: { kind: "proceed", ...call } });
      return undefined;
    }
    default:
      return "not built yet";
  }
}
