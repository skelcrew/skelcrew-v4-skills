import { describe, expect, test } from "bun:test";
import { agent, aTask, judge, noUsage, plugin, refused, workspace, you } from "./testing";
import type { Task } from "./types";

// A planner at work: workspace from request 1, session from request 2.
const planning: Task = aTask(
  {
    phase: "triage",
    overrides: {},
    workspace,
    step: { kind: "running", session: 2 },
    attached: false,
  },
  { sessions: [{ session: 2, role: "planner", harnessId: "h2", usage: noUsage }] },
);

describe("a reply the task no longer waits on", () => {
  test("a workspace created late is removed, and nothing is recorded", () => {
    const decision = judge(
      planning,
      plugin({ kind: "workspace_created", request: 7, path: "/w/late" }),
    );
    expect(decision).toEqual({
      ok: true,
      events: [],
      commands: [{ kind: "remove_workspace", task: "t1", path: "/w/late" }],
    });
  });

  test("a session started late is stopped without saving", () => {
    const decision = judge(
      planning,
      plugin({ kind: "session_started", request: 7, harnessId: "h7" }),
    );
    expect(decision).toEqual({
      ok: true,
      events: [],
      commands: [{ kind: "stop_session", task: "t1", session: 7, save: false }],
    });
  });

  test("a repeat of the start reply for the running session changes nothing", () => {
    const decision = judge(
      planning,
      plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
    );
    expect(decision).toEqual({ ok: true, events: [], commands: [] });
  });

  test("a repeat of the created reply for the task's workspace changes nothing", () => {
    const decision = judge(
      planning,
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    );
    expect(decision).toEqual({ ok: true, events: [], commands: [] });
  });

  test.each([
    plugin({ kind: "workspace_failed", request: 7, error: "disk full" }),
    plugin({ kind: "session_failed", request: 7, error: "no tmux" }),
    plugin({ kind: "session_ended", session: 7, exitCode: 1, lastLine: "bye" }),
    plugin({ kind: "session_stopped", session: 7, save: "saved" }),
    plugin({ kind: "main_merged", request: 7, commit: "c", files: [] }),
    plugin({ kind: "main_conflict", request: 7 }),
    plugin({ kind: "main_failed", request: 7, error: "lock" }),
    plugin({ kind: "output_delivered", request: 7 }),
    plugin({ kind: "output_failed", request: 7, error: "down" }),
  ])("a late $kind needs no cleanup", (input) => {
    expect(judge(planning, input)).toEqual({ ok: true, events: [], commands: [] });
  });
});

describe("an agent is heard only in its own role", () => {
  test("a session claiming another role than the one it was started for", () => {
    const decision = judge(
      planning,
      agent({ session: 2, role: "tester", kind: "pass", evidence: "ok" }),
    );
    expect(refused(decision)).toBe("session 2 is the planner, not the tester");
  });

  test("a role that doesn't work this phase", () => {
    const building = aTask(planning.state, {
      sessions: [{ session: 2, role: "builder", harnessId: "h2", usage: noUsage }],
    });
    const decision = judge(
      building,
      agent({ session: 2, role: "builder", kind: "progress", text: "hi" }),
    );
    expect(refused(decision)).toBe("a builder doesn't work in triage");
  });
});

describe("an ended task", () => {
  const ended = aTask({ phase: "ended", outcome: { kind: "killed" }, proposals: [] });

  test.each([
    you({ kind: "pause" }),
    you({ kind: "start" }),
    you({ kind: "set", intent: "ship" }),
    you({ kind: "reply", text: "yes" }),
    you({ kind: "kill" }),
  ])("refuses $kind, since nothing leaves an ending", (input) => {
    expect(refused(judge(ended, input))).toBe("task t1 has ended");
  });

  test("still cleans up after a late session", () => {
    const decision = judge(ended, plugin({ kind: "session_started", request: 2, harnessId: "h" }));
    expect(decision).toEqual({
      ok: true,
      events: [],
      commands: [{ kind: "stop_session", task: "t1", session: 2, save: false }],
    });
  });
});
