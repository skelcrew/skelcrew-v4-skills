// An agent's question, your answer, and typing the answer into the
// session once a slot is free. `docs/core.md` part 8.

import type { Draft } from "./draft";
import { runningSession } from "./task";
import type { ActiveState, Answer } from "./types";

export function ask(
  draft: Draft,
  state: ActiveState,
  session: number,
  text: string,
  options: string[],
): string | undefined {
  if (state.question !== undefined) return "a question is already open";
  if (text.trim() === "") return "the question is empty";
  draft.record({ type: "question.asked", session, text, options });
  return undefined;
}

// Your answer is kept until a slot is free. A second one replaces it.
export function answer(draft: Draft, state: ActiveState, given: Answer): string | undefined {
  if (state.question === undefined) return `task ${draft.task.id} has no open question`;
  if (given.text.trim() === "") return "the reply is empty";
  draft.record({ type: "question.answered", answer: given });
  return undefined;
}

export function deliverAnswer(draft: Draft, state: ActiveState): string | undefined {
  const question = state.question;
  if (question?.answer === undefined) return `task ${draft.task.id} has no answer waiting`;
  if (state.attached) return `you are attached to task ${draft.task.id}, so say it yourself`;
  if (state.hold !== undefined || runningSession(draft.task) !== question.session) {
    return `task ${draft.task.id} has no agent to give the answer to`;
  }
  draft.record({ type: "answer.delivered" });
  draft.send({
    kind: "type_into_session",
    task: draft.task.id,
    session: question.session,
    text: question.answer.text,
  });
  return undefined;
}
