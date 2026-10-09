// You stepping into the agent's session, and back out.

import { handOver } from "./build";
import type { Draft } from "./draft";
import { runningSession } from "./task";
import type { ActiveState, YouInput } from "./types";

export function attach(draft: Draft, state: ActiveState): string | undefined {
  if (state.attached) return `you are already attached to task ${draft.task.id}`;
  if (runningSession(draft.task) === undefined) {
    return `task ${draft.task.id} has no running session to attach to`;
  }
  draft.record({ type: "session.attached" });
  return undefined;
}

type Detach = Extract<YouInput, { kind: "detach" }>;

export function detach(draft: Draft, state: ActiveState, input: Detach): string | undefined {
  if (!state.attached) return `you aren't attached to task ${draft.task.id}`;
  const session = runningSession(draft.task);
  if (input.choice === "resume" || session === undefined) {
    draft.record({ type: "session.detached", choice: "resume" });
    return undefined;
  }
  if (state.phase !== "build") return "only a builder's work can be handed over";
  if (state.intent === "answer") {
    return "an answer needs the builder's report, so it can't be handed over. Detach with resume.";
  }
  draft.record({ type: "session.detached", choice: "hand_over" });
  handOver(draft, state, session, {
    intent: state.intent,
    commit: input.commit,
    files: input.files,
    by: "you",
    work: { kind: "summary", text: "Handed over by you." },
  });
  return undefined;
}
