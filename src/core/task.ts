// Reading a task. Each question about a task has one answer here, shared
// by decide, evolve, the scheduler and the tests.

import type { ActiveState, Task } from "./types";

// The task's branch, such as `skel/142-empty-export`. The same task always
// gets the same name.
export function branchName(task: Pick<Task, "id" | "title">): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? `skel/${task.id}` : `skel/${task.id}-${slug}`;
}

// The brief when triage is skipped: the title and description.
export function plainBrief(task: Pick<Task, "title" | "description">): string {
  return task.description === "" ? task.title : `${task.title}\n\n${task.description}`;
}

export function isActive(state: Task["state"]): state is ActiveState {
  return state.phase !== "ended";
}

// The session the task's step holds as its working agent, if any.
export function runningSession(task: Task): number | undefined {
  const step = task.state.phase === "ended" ? undefined : task.state.step;
  return step?.kind === "running" ? step.session : undefined;
}
