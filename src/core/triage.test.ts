import { describe, expect, test } from "bun:test";
import { daemon, more, play, plugin, refused, taskOf, types, you } from "./testing";

const added = () => play([you({ kind: "add", title: "Fix export", description: "It crashes" })]);

describe("starting triage", () => {
  test("the scheduler's start asks for the task's workspace on its branch", () => {
    const run = more(added(), [daemon({ kind: "start" })]);
    expect(types(run.events)).toEqual(["workspace.requested"]);
    expect(run.commands).toEqual([
      {
        kind: "create_workspace",
        task: "t1",
        request: 1,
        workspace: { kind: "task", branch: "skel/t1-fix-export" },
      },
    ]);
    const task = taskOf(run);
    expect(task.requests).toBe(1);
    expect(task.state.phase === "triage" && task.state.step).toEqual({
      kind: "creating_workspace",
      request: 1,
    });
  });

  test("once the workspace exists, the planner starts read only, with the title as brief", () => {
    const run = more(added(), [
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    ]);
    expect(types(run.events)).toEqual([
      "workspace.requested",
      "workspace.created",
      "session.requested",
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "start_session",
      task: "t1",
      request: 2,
      role: "planner",
      path: "/w/t1",
      edits: false,
      brief: "Fix export\n\nIt crashes",
    });
    const state = taskOf(run).state;
    expect(state.phase === "triage" && state.workspace).toEqual({
      request: 1,
      path: "/w/t1",
      branch: "skel/t1-fix-export",
      unsaved: false,
    });
    expect(state.phase === "triage" && state.step).toEqual({ kind: "starting", request: 2 });
  });

  test("the planner's start reply sets it running", () => {
    const run = more(added(), [
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
    ]);
    const task = taskOf(run);
    expect(task.state.phase === "triage" && task.state.step).toEqual({
      kind: "running",
      session: 2,
    });
    expect(task.sessions).toEqual([
      {
        session: 2,
        role: "planner",
        harnessId: "h2",
        usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, minutes: 0 },
      },
    ]);
  });

  test("a workspace that can't be created holds the task, waiting again", () => {
    const run = more(added(), [
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_failed", request: 1, error: "disk full" }),
    ]);
    expect(types(run.events)).toEqual(["workspace.requested", "workspace.failed", "task.held"]);
    expect(run.commands).toHaveLength(1);
    const state = taskOf(run).state;
    expect(state.phase === "triage" && state.step).toEqual({ kind: "queued" });
    expect(state.phase === "triage" && state.hold).toEqual({
      kind: "failed",
      what: "workspace",
      error: "disk full",
    });
  });

  test("a session that can't be started holds the task, keeping its workspace", () => {
    const run = more(added(), [
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      plugin({ kind: "session_failed", request: 2, error: "untrusted folder" }),
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "triage" && state.step).toEqual({ kind: "queued" });
    expect(state.phase === "triage" && state.workspace?.path).toBe("/w/t1");
    expect(state.phase === "triage" && state.hold).toEqual({
      kind: "failed",
      what: "session",
      error: "untrusted folder",
    });
  });

  test("the scheduler can't start a held task", () => {
    const run = more(added(), [
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_failed", request: 1, error: "disk full" }),
      daemon({ kind: "start" }),
    ]);
    expect(refused(run.last)).toBe("task t1 is held: its workspace couldn't be created");
  });

  test("the scheduler can't start a task that is already under way", () => {
    const run = more(added(), [daemon({ kind: "start" }), daemon({ kind: "start" })]);
    expect(refused(run.last)).toBe("task t1 isn't waiting for a slot");
  });

  test("a repeated created reply starts no second planner", () => {
    const run = more(added(), [
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    ]);
    expect(run.commands.filter((c) => c.kind === "start_session")).toHaveLength(1);
    expect(run.commands.filter((c) => c.kind === "remove_workspace")).toHaveLength(0);
  });
});
