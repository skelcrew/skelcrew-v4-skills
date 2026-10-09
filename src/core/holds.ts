// Holding a task and lifting the hold, killing it, and the failures that
// let an agent go: a crash and giving up. `docs/core.md` part 6.

import { deliver } from "./delivery";
import type { Draft } from "./draft";
import { removeWorkspace, stopAgent } from "./stop";
import { holdText, runningSession } from "./task";
import type { ActiveState, EndReason, PluginInput, Task } from "./types";

// Whether stopping the task's agent saves its work. Only a builder that can
// edit has anything to save, and that follows the intent its session was
// started for, which a change of intent doesn't alter.
export function saves(task: Task): boolean {
  const state = task.state;
  if (state.phase !== "build") return false;
  const step = state.step;
  const intent = "intent" in step ? step.intent : state.intent;
  return intent !== "answer";
}

export function letGo(draft: Draft, session: number, reason: EndReason): void {
  stopAgent(draft, session, reason, saves(draft.task));
}

export function pause(draft: Draft, state: ActiveState): string | undefined {
  if (state.hold?.kind === "paused") return `task ${draft.task.id} is already paused`;
  if (state.hold !== undefined)
    return `task ${draft.task.id} is already held: ${holdText(state.hold)}`;
  draft.record({ type: "task.paused" });
  const session = runningSession(draft.task);
  if (session !== undefined) letGo(draft, session, "stopped");
  return undefined;
}

// Resume lifts only your pause. Retry lifts any hold.
export function lift(
  draft: Draft,
  state: ActiveState,
  via: "resume" | "retry",
): string | undefined {
  const hold = state.hold;
  if (via === "resume") {
    if (hold === undefined) return `task ${draft.task.id} isn't paused`;
    if (hold.kind !== "paused") {
      return `task ${draft.task.id} is held because ${holdText(hold)}. Retry it instead.`;
    }
  }
  if (hold === undefined) return `task ${draft.task.id} isn't held`;
  draft.record({ type: "task.resumed", via });
  deliver(draft);
  return undefined;
}

export function kill(draft: Draft, state: ActiveState): string | undefined {
  const session = runningSession(draft.task);
  if (session !== undefined) letGo(draft, session, "stopped");
  draft.record({ type: state.hold?.kind === "loop_cap" ? "task.failed" : "task.killed" });
  removeIdle(draft);
  return undefined;
}

// Removes what an ended task holds and no agent runs in. A workspace whose
// save failed stays. A split or decline deletes the branch too.
export function removeIdle(draft: Draft): void {
  const state = draft.task.state;
  if (state.phase !== "ended") return;
  const inCopy = state.copy !== undefined;
  const busy = state.agent !== undefined;
  if (state.copy !== undefined && !busy) {
    removeWorkspace(draft, state.copy.request, state.copy.path);
  }
  const workspace = state.workspace;
  if (workspace !== undefined && !workspace.unsaved && (!busy || inCopy)) {
    const branch = state.outcome.kind === "split" || state.outcome.kind === "declined";
    removeWorkspace(
      draft,
      workspace.request,
      workspace.path,
      branch ? workspace.branch : undefined,
    );
  }
}

export function giveUp(draft: Draft, session: number, reason: string): string | undefined {
  if (reason.trim() === "") return "giving up needs a reason";
  draft.record({ type: "task.held", hold: { kind: "gave_up", reason } });
  letGo(draft, session, "reported");
  return undefined;
}

type Ended = Extract<PluginInput, { kind: "session_ended" }>;

// A session ended without reporting. It holds the task, and still gets a
// stop: its pane stays open, and its work still needs saving.
export function crashed(draft: Draft, input: Ended): void {
  draft.record({
    type: "task.held",
    hold: {
      kind: "crashed",
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      lastLine: input.lastLine,
    },
  });
  letGo(draft, input.session, "crashed");
}

type SessionReply = Extract<
  PluginInput,
  { kind: "session_started" | "session_failed" | "session_ended" }
>;

// An ended task's agent was still starting. Once it answers, it is
// stopped, or its workspace is removed if it never started.
export function endedStart(draft: Draft, input: SessionReply): string | undefined {
  const state = draft.task.state;
  if (state.phase !== "ended") return undefined;
  const agent = state.agent;
  if (agent?.kind === "stopping") return undefined; // The stop in flight will answer.
  if (agent?.kind !== "starting") return `task ${draft.task.id} has ended`;
  switch (input.kind) {
    case "session_started":
      draft.record({ type: "session.started", session: input.request, harnessId: input.harnessId });
      stopAgent(draft, input.request, "stopped", agent.save);
      return undefined;
    case "session_failed":
      draft.record({ type: "session.failed", request: input.request, error: input.error });
      removeIdle(draft);
      return undefined;
    case "session_ended":
      stopAgent(draft, input.session, "crashed", agent.save);
      return undefined;
  }
}
