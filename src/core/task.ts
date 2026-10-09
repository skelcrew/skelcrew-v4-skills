// Reading a task. Each question about a task has one answer here, shared
// by decide, evolve, the scheduler and the tests.

import type { ActiveState, Hold, Role, Task } from "./types";

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

export type Waiting = "creating_workspace" | "starting" | "merging" | "delivering";

// Whether the task waits on this request, for a step of this kind. An
// ended task can still wait on a session's start.
export function waitsOn(task: Task, kind: Waiting, request: number): boolean {
  const state = task.state;
  if (state.phase === "ended") {
    return (
      kind === "starting" && state.agent?.kind === "starting" && state.agent.request === request
    );
  }
  const step = state.step;
  return step.kind === kind && step.request === request;
}

// The session whose stop the task waits on, if any.
export function stoppingSession(task: Task): number | undefined {
  const state = task.state;
  if (state.phase === "ended") {
    return state.agent?.kind === "stopping" ? state.agent.session : undefined;
  }
  return state.step.kind === "stopping" ? state.step.session : undefined;
}

// Whether the task holds this session as its agent: running, or being
// stopped.
export function holdsSession(task: Task, session: number): boolean {
  return runningSession(task) === session || stoppingSession(task) === session;
}

// The requests that made the workspaces the task holds: its own, and the
// tester's copy.
export function heldWorkspaces(task: Task): number[] {
  const state = task.state;
  const held: number[] = [];
  if (state.workspace !== undefined) held.push(state.workspace.request);
  if (state.phase === "ended") {
    if (state.copy !== undefined) held.push(state.copy.request);
  } else if (state.phase === "review" && "copy" in state.step && state.step.copy !== undefined) {
    held.push(state.step.copy.request);
  }
  return held;
}

const roleOfPhase: Record<ActiveState["phase"], Role> = {
  triage: "planner",
  build: "builder",
  review: "tester",
};

// The role that works the phase, if any.
export function phaseRole(task: Task): Role | undefined {
  return task.state.phase === "ended" ? undefined : roleOfPhase[task.state.phase];
}

export function sessionRole(task: Task, session: number): Role | undefined {
  return task.sessions.find((record) => record.session === session)?.role;
}

// The paths of the workspaces the task holds.
export function heldPaths(task: Task): string[] {
  const state = task.state;
  const paths: string[] = [];
  if (state.workspace !== undefined) paths.push(state.workspace.path);
  if (state.phase === "ended") {
    if (state.copy !== undefined) paths.push(state.copy.path);
  } else if (state.phase === "review" && "copy" in state.step && state.step.copy !== undefined) {
    paths.push(state.step.copy.path);
  }
  return paths;
}

const failedWhat = {
  workspace: "its workspace couldn't be created",
  session: "its session couldn't be started",
  merge: "merging main failed",
  delivery: "its output couldn't be delivered",
};

// Why a task is held, in plain words.
export function holdText(hold: Hold): string {
  switch (hold.kind) {
    case "paused":
      return "you paused it";
    case "crashed":
      return hold.exitCode === undefined
        ? `its session ended without reporting: ${hold.lastLine}`
        : `its session crashed with exit code ${hold.exitCode}: ${hold.lastLine}`;
    case "gave_up":
      return `its agent gave up: ${hold.reason}`;
    case "loop_cap":
      return `the loop cap was reached: ${hold.findings}`;
    case "failed":
      return failedWhat[hold.what];
    case "unsaved":
      return hold.after === undefined
        ? "its work couldn't be saved"
        : `its work couldn't be saved, after ${holdText(hold.after)}`;
  }
}
