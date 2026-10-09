// `skel set`: your change of intent, rigor or approval. It is never
// refused for timing. Its effect comes at once when nothing is in flight,
// and otherwise when the step in flight settles. `docs/core.md` part 9.

import { backToBuild, buildFromOverrides, isStale, triageSkipped } from "./advance";
import { deliver } from "./delivery";
import type { Draft } from "./draft";
import { letGo } from "./holds";
import { runningSession } from "./task";
import type { ActiveState, YouInput } from "./types";

type SetInput = Extract<YouInput, { kind: "set" }>;

export function change(draft: Draft, input: SetInput): string | undefined {
  const settings = {
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.rigor === undefined ? {} : { rigor: input.rigor }),
    ...(input.approve === undefined ? {} : { approve: input.approve }),
  };
  if (Object.keys(settings).length === 0) return "name an intent, rigor or approval to change";
  draft.record({ type: "task.set", ...settings });
  const state = draft.task.state;
  if (state.phase === "ended") return undefined;
  if (state.phase === "triage") {
    if (triageSkipped(state)) endTriage(draft, state);
    return undefined;
  }
  if (isStale(state)) setAsideStaleWork(draft, state);
  if (input.approve !== undefined) applyApproval(draft);
  return undefined;
}

// Intent and rigor together end triage. A queued task moves to build at
// once. A running planner is stopped first. Anything in flight settles
// first.
function endTriage(draft: Draft, state: ActiveState): void {
  if (state.step.kind === "queued") buildFromOverrides(draft);
  const session = runningSession(draft.task);
  if (session !== undefined) letGo(draft, session, "stopped");
}

// Work made for the old intent. A running agent is stopped and replaced.
// A task at rest on its last steps goes back to build. Anything in flight
// settles first.
function setAsideStaleWork(draft: Draft, state: ActiveState): void {
  const session = runningSession(draft.task);
  if (session !== undefined) {
    letGo(draft, session, "stopped");
    return;
  }
  if (state.phase === "triage") return;
  const step = state.step;
  if (step.kind === "awaiting_approval" || step.kind === "ready") {
    backToBuild(draft, state);
    return;
  }
  if (state.phase === "review" && state.step.kind === "queued") {
    const copy = state.step.copy;
    if (copy !== undefined) {
      draft.record({ type: "workspace.removed", request: copy.request });
      draft.send({ kind: "remove_workspace", task: draft.task.id, path: copy.path });
    }
    const now = draft.task.state;
    if (now.phase === "review") backToBuild(draft, now);
  }
}

// Setting approval on a ready output makes it wait for you. Clearing it on
// one waiting for you delivers it, unless a critical file still needs you.
function applyApproval(draft: Draft): void {
  const state = draft.task.state;
  if (state.phase === "ended" || state.phase === "triage") return;
  const step = state.step;
  if (step.kind === "ready" && state.approve) {
    draft.record({ type: "approval.requested" });
  } else if (step.kind === "awaiting_approval" && !state.approve && !step.critical) {
    draft.record({ type: "output.ready", output: step.output, critical: step.critical });
    deliver(draft);
  }
}
