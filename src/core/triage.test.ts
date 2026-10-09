import { describe, expect, test } from "bun:test";
import { agent, daemon, more, play, plugin, refused, taskOf, types, you } from "./testing";
import type { Intent, Rigor, Spec } from "./types";

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

// A planner at work: workspace from request 1, session 2.
const planning = (settings: { intent?: "ship" | "try" | "answer"; approve?: boolean } = {}) =>
  play([
    you({ kind: "add", title: "Fix export", description: "It crashes", ...settings }),
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
  ]);

const spec = { path: "docs/plans/t1-fix-export.md", text: "# Plan" };

type Call = { intent?: Intent; rigor?: Rigor; brief?: string; spec?: Spec | "none" };

const proceed = (call: Call = {}) => {
  const chosen = call.spec ?? spec;
  return agent({
    session: 2,
    role: "planner",
    kind: "proceed",
    intent: call.intent ?? "ship",
    rigor: call.rigor ?? "full",
    approve: false,
    brief: call.brief ?? "Export crashes on empty reports.",
    ...(chosen === "none" ? {} : { spec: chosen }),
  });
};

describe("the planner proceeds", () => {
  test("the planner is stopped, saving the spec, and its call is kept", () => {
    const run = more(planning(), [proceed()]);
    expect(types(run.events)).toEqual(["session.stopping", "task.triaged"]);
    expect(run.commands).toEqual([
      { kind: "stop_session", task: "t1", session: 2, save: true, write: spec },
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "triage" && state.step).toEqual({
      kind: "stopping",
      session: 2,
      reason: "reported",
      proceed: {
        intent: "ship",
        rigor: "full",
        approve: false,
        brief: "Export crashes on empty reports.",
        spec,
      },
    });
  });

  test("without a spec, the stop doesn't save", () => {
    const run = more(planning(), [proceed({ rigor: "light", spec: "none" })]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: false }]);
  });

  test("a light call with a spec is refused", () => {
    const run = more(planning(), [proceed({ rigor: "light" })]);
    expect(refused(run.last)).toBe("a light task gets no spec");
  });

  test("a call with an empty brief is refused", () => {
    const run = more(planning(), [proceed({ brief: " " })]);
    expect(refused(run.last)).toBe("the brief is empty");
  });

  test("a second report while the first one's stop is in flight is refused", () => {
    const run = more(planning(), [proceed(), proceed()]);
    expect(refused(run.last)).toBe("session 2 isn't the task's agent");
  });

  test("once the stop is confirmed, build starts and the builder is asked for", () => {
    const run = more(planning(), [
      proceed(),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }),
    ]);
    expect(types(run.events)).toEqual([
      "session.stopping",
      "task.triaged",
      "session.ended",
      "phase.started",
      "session.requested",
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "start_session",
      task: "t1",
      request: 3,
      role: "builder",
      path: "/w/t1",
      edits: true,
      intent: "ship",
      rigor: "full",
      brief: "Export crashes on empty reports.",
      spec,
    });
    const state = taskOf(run).state;
    expect(state).toEqual({
      phase: "build",
      intent: "ship",
      rigor: "full",
      approve: false,
      brief: "Export crashes on empty reports.",
      spec,
      loops: 0,
      workspace: { request: 1, path: "/w/t1", branch: "skel/t1-fix-export", unsaved: false },
      step: { kind: "starting", request: 3, intent: "ship" },
      attached: false,
    });
  });

  test("your intent and approval win over the planner's call", () => {
    const run = more(planning({ intent: "answer", approve: true }), [
      proceed({ spec: "none" }),
      plugin({ kind: "session_stopped", session: 2, save: "nothing" }),
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && [state.intent, state.rigor, state.approve]).toEqual([
      "answer",
      "full",
      true,
    ]);
    const start = run.commands.at(-1);
    expect(start?.kind === "start_session" && start.edits).toBe(false);
  });

  test("a session end while the stop is in flight changes nothing", () => {
    const run = more(planning(), [
      proceed(),
      plugin({ kind: "session_ended", session: 2, exitCode: 0, lastLine: "bye" }),
    ]);
    expect(run.last).toEqual({ ok: true, events: [], commands: [] });
  });
});

const proposals = [
  { title: "Export headers", description: "Write headers on empty reports" },
  { title: "Export footers", description: "Write footers too" },
];

const split = () => agent({ session: 2, role: "planner", kind: "split", proposals });

describe("the planner splits or declines", () => {
  test("a split ends the task at once, while the planner stops without saving", () => {
    const run = more(planning(), [split()]);
    expect(types(run.events)).toEqual(["session.stopping", "task.triaged"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: false }]);
    expect(taskOf(run).state).toEqual({
      phase: "ended",
      outcome: { kind: "split" },
      proposals: proposals.map((p) => ({ ...p, decision: "pending" })),
      agent: { kind: "stopping", session: 2, reason: "reported" },
      workspace: { request: 1, path: "/w/t1", branch: "skel/t1-fix-export", unsaved: false },
    });
  });

  test("a split with no proposals is refused", () => {
    const run = more(planning(), [
      agent({ session: 2, role: "planner", kind: "split", proposals: [] }),
    ]);
    expect(refused(run.last)).toBe("a split needs at least one proposal");
  });

  test("a decline ends the task with its reason", () => {
    const run = more(planning(), [
      agent({ session: 2, role: "planner", kind: "decline", reason: "Fixed in #131" }),
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "ended" && state.outcome).toEqual({
      kind: "declined",
      reason: "Fixed in #131",
    });
    expect(state.phase === "ended" && state.proposals).toEqual([]);
  });

  test("a decline with no reason is refused", () => {
    const run = more(planning(), [
      agent({ session: 2, role: "planner", kind: "decline", reason: "" }),
    ]);
    expect(refused(run.last)).toBe("a decline needs a reason");
  });

  test("once the planner's stop is confirmed, the workspace and its branch are removed", () => {
    const run = more(planning(), [
      split(),
      plugin({ kind: "session_stopped", session: 2, save: "nothing" }),
    ]);
    expect(types(run.events)).toEqual([
      "session.stopping",
      "task.triaged",
      "session.ended",
      "workspace.removed",
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "remove_workspace",
      task: "t1",
      path: "/w/t1",
      deleteBranch: "skel/t1-fix-export",
    });
    const state = taskOf(run).state;
    expect(state.phase === "ended" && [state.agent, state.workspace]).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("if the save fails, the workspace is kept for good", () => {
    const run = more(planning(), [
      split(),
      plugin({ kind: "session_stopped", session: 2, save: "failed" }),
    ]);
    expect(run.commands.filter((c) => c.kind === "remove_workspace")).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "ended" && state.agent).toBeUndefined();
    expect(state.phase === "ended" && state.workspace?.unsaved).toBe(true);
  });

  test("an ended task still refuses anything else", () => {
    const run = more(planning(), [split(), you({ kind: "start" })]);
    expect(refused(run.last)).toBe("task t1 has ended");
  });
});

describe("your decisions on a split's proposals", () => {
  const ended = () => more(planning(), [split()]);

  test("approving one asks the task source to add it", () => {
    const run = more(ended(), [you({ kind: "approve_proposals", which: [1] })]);
    expect(types(run.events)).toEqual(["proposals.approved"]);
    expect(run.commands).toEqual([
      { kind: "add_tasks", task: "t1", proposals: proposals.slice(1) },
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "ended" && state.proposals.map((p) => p.decision)).toEqual([
      "pending",
      "approved",
    ]);
  });

  test("denying one adds nothing", () => {
    const run = more(ended(), [you({ kind: "deny_proposals", which: [0] })]);
    expect(types(run.events)).toEqual(["proposals.denied"]);
    expect(run.commands).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "ended" && state.proposals.map((p) => p.decision)).toEqual([
      "denied",
      "pending",
    ]);
  });

  test("a proposal already decided can't be decided again", () => {
    const run = more(ended(), [
      you({ kind: "approve_proposals", which: [0] }),
      you({ kind: "deny_proposals", which: [0] }),
    ]);
    expect(refused(run.last)).toBe("proposal 0 is already approved");
  });

  test("a proposal that doesn't exist is refused", () => {
    const run = more(ended(), [you({ kind: "approve_proposals", which: [2] })]);
    expect(refused(run.last)).toBe("there is no proposal 2");
  });

  test("naming no proposal is refused", () => {
    const run = more(ended(), [you({ kind: "approve_proposals", which: [] })]);
    expect(refused(run.last)).toBe("name at least one proposal");
  });

  test("naming the same proposal twice is refused", () => {
    const run = more(ended(), [you({ kind: "approve_proposals", which: [0, 0] })]);
    expect(refused(run.last)).toBe("proposal 0 is named twice");
  });

  test("a task that hasn't ended has no proposals to decide", () => {
    const run = more(planning(), [you({ kind: "approve_proposals", which: [0] })]);
    expect(refused(run.last)).toBe("task t1 has no proposals until it ends");
  });
});
