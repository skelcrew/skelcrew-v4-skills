// The builder's inputs during build, and merging main.

import { advance } from "./advance";
import { outputOf, ready } from "./delivery";
import type { Draft } from "./draft";
import { stopAgent } from "./stop";
import {
  type AgentInput,
  type BuildState,
  type Handover,
  LOOP_CAP,
  type PluginInput,
} from "./types";

export function builderCall(
  draft: Draft,
  state: BuildState,
  input: AgentInput,
): string | undefined {
  switch (input.kind) {
    case "progress":
      draft.record({ type: "progress.reported", session: input.session, text: input.text });
      return undefined;
    case "done": {
      if (state.question !== undefined) return "the agent's own question is still open";
      const wants = state.intent === "answer" ? "report" : "summary";
      if (input.work.kind !== wants) {
        const article = state.intent === "answer" ? "an" : "a";
        return `${article} ${state.intent} task hands over a ${wants}, not a ${input.work.kind}`;
      }
      handOver(draft, state, input.session, {
        intent: state.intent,
        commit: input.commit,
        files: input.files,
        by: "builder",
        work: input.work,
      });
      return undefined;
    }
    default:
      return "not built yet";
  }
}

// The builder is let go and its work is fixed: the commit and every file
// the branch changed. Merging main or review follows once it has stopped.
export function handOver(
  draft: Draft,
  state: BuildState,
  session: number,
  handover: Handover,
): void {
  stopAgent(draft, session, "reported", state.intent !== "answer");
  draft.record({ type: "build.done", handover });
}

type MergeReply = Extract<PluginInput, { kind: "main_merged" | "main_conflict" | "main_failed" }>;

export function merged(draft: Draft, input: MergeReply): void {
  switch (input.kind) {
    case "main_merged": {
      const before = draft.task.state;
      draft.record({
        type: "main.merged",
        request: input.request,
        commit: input.commit,
        files: input.files,
      });
      if (before.phase !== "build" || before.step.kind !== "merging") return;
      const reviewed = { commit: input.commit, files: input.files };
      const handover = before.step.handover;
      if (before.intent === "ship") {
        draft.record({ type: "phase.started", phase: "review", handover, reviewed });
        advance(draft);
        return;
      }
      if (before.workspace === undefined) return;
      ready(
        draft,
        outputOf(before.workspace.branch, handover, reviewed),
        input.files,
        before.approve,
      );
      return;
    }
    case "main_conflict": {
      draft.record({ type: "main.conflict", request: input.request });
      const after = draft.task.state;
      if (after.phase === "build" && after.loops >= LOOP_CAP) {
        draft.record({
          type: "task.held",
          hold: { kind: "loop_cap", findings: "merging main conflicted" },
        });
      }
      advance(draft);
      return;
    }
    case "main_failed":
      draft.record({ type: "main.failed", request: input.request, error: input.error });
      draft.record({
        type: "task.held",
        hold: { kind: "failed", what: "merge", error: input.error },
      });
      return;
  }
}
