// The scheduler: which task gets a free slot. It reads only the tasks. An
// ended task keeps the agent it still waits on, so every start and stop in
// flight shows in some task's state. `docs/core.md` part 10.

import type { Config, DaemonInput, Task, Usage } from "./types";

// Whether the task holds a slot. A request in flight holds one, held or
// not. A running agent holds one unless it waits on your answer, and you
// attached hold one always.
export function holdsSlot(task: Task): boolean {
  const state = task.state;
  if (state.phase === "ended") return state.agent !== undefined;
  switch (state.step.kind) {
    case "creating_workspace":
    case "starting":
    case "stopping":
    case "merging":
      return true;
    case "running":
      return state.attached || (state.question === undefined && state.hold === undefined);
    default:
      return false;
  }
}

export function slotsInUse(tasks: Task[]): number {
  return tasks.filter(holdsSlot).length;
}

// The daemon inputs for every free slot: kept answers first, then resumed
// tasks, then queued ones. Oldest first within each, by arrival then ID.
export function schedule(tasks: Task[], config: Config, at: number): DaemonInput[] {
  const free = config.maxRunning - slotsInUse(tasks);
  if (free <= 0) return [];
  const oldest = [...tasks].sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
  const answers = oldest.filter(hasAnswerWaiting);
  const queued = oldest.filter(waitsForSlot);
  const resumed = queued.filter((task) => task.state.phase !== "ended" && task.state.lifted);
  const fresh = queued.filter((task) => !resumed.includes(task));
  const answerInputs = answers.map(
    (task): DaemonInput => ({ sender: "daemon", task: task.id, at, kind: "deliver_answer" }),
  );
  const startInputs = [...resumed, ...fresh].map(
    (task): DaemonInput => ({ sender: "daemon", task: task.id, at, kind: "start" }),
  );
  return [...answerInputs, ...startInputs].slice(0, free);
}

function hasAnswerWaiting(task: Task): boolean {
  const state = task.state;
  return (
    state.phase !== "ended" &&
    state.step.kind === "running" &&
    state.question?.answer !== undefined &&
    !state.attached &&
    state.hold === undefined
  );
}

function waitsForSlot(task: Task): boolean {
  const state = task.state;
  return state.phase !== "ended" && state.step.kind === "queued" && state.hold === undefined;
}

// A task's usage: the sum of its sessions'. It is shown, never enforced.
export function taskUsage(task: Task): Usage {
  const sum: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, minutes: 0 };
  for (const { usage } of task.sessions) {
    sum.input += usage.input;
    sum.output += usage.output;
    sum.cacheWrite += usage.cacheWrite;
    sum.cacheRead += usage.cacheRead;
    sum.minutes += usage.minutes;
  }
  return sum;
}
