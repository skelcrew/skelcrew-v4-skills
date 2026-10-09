import { describe, expect, test } from "bun:test";
import { evolve } from "./evolve";
import {
  agent,
  daemon,
  more,
  type Played,
  play,
  plugin,
  refused,
  taskOf,
  types,
  you,
} from "./testing";
import { type Event, LOOP_CAP } from "./types";

// A ship task through build and the merge, with review just started:
// workspace 1, builder 2, merge 3, then the tester's copy is request 4.
const merged = () =>
  play([
    you({
      kind: "add",
      title: "Fix export",
      description: "It crashes",
      intent: "ship",
      rigor: "full",
    }),
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
    agent({
      session: 2,
      role: "builder",
      kind: "done",
      commit: "c1",
      files: ["src/export.ts"],
      work: { kind: "summary", text: "Headers" },
    }),
    plugin({ kind: "session_stopped", session: 2, save: "saved" }),
    plugin({ kind: "main_merged", request: 3, commit: "m3", files: ["src/export.ts"] }),
  ]);

// The tester at work: copy from request 4, session 5.
const testing = () =>
  more(merged(), [
    plugin({ kind: "workspace_created", request: 4, path: "/w/t1-copy" }),
    plugin({ kind: "session_started", request: 5, harnessId: "h5" }),
  ]);

const pass = (session = 5) =>
  agent({ session, role: "tester", kind: "pass", evidence: "All green" });
const changes = (session = 5) =>
  agent({ session, role: "tester", kind: "changes", findings: "No test for empty reports" });

describe("starting review", () => {
  test("review asks at once for the tester's copy at the reviewed commit", () => {
    const run = merged();
    expect(types(run.events).slice(-3)).toEqual([
      "main.merged",
      "phase.started",
      "workspace.requested",
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "create_workspace",
      task: "t1",
      request: 4,
      workspace: { kind: "copy", commit: "m3" },
    });
  });

  test("once the copy exists, the tester starts read only, with what to review", () => {
    const run = more(merged(), [
      plugin({ kind: "workspace_created", request: 4, path: "/w/t1-copy" }),
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "start_session",
      task: "t1",
      request: 5,
      role: "tester",
      path: "/w/t1-copy",
      edits: false,
      intent: "ship",
      rigor: "full",
      brief: "Fix export\n\nIt crashes",
      review: { commit: "m3", work: { kind: "summary", text: "Headers" } },
    });
  });

  test("the tester's start reply sets it running in its copy", () => {
    const state = taskOf(testing()).state;
    expect(state.phase === "review" && state.step).toEqual({
      kind: "running",
      session: 5,
      copy: { request: 4, path: "/w/t1-copy", commit: "m3" },
    });
  });

  test("a copy that can't be made holds the task", () => {
    const run = more(merged(), [
      plugin({ kind: "workspace_failed", request: 4, error: "disk full" }),
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "review" && state.hold?.kind).toBe("failed");
  });
});

describe("the verdict", () => {
  test("a pass stops the tester without saving", () => {
    const run = more(testing(), [pass()]);
    expect(types(run.events)).toEqual(["session.stopping", "review.passed"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 5, save: false }]);
    const state = taskOf(run).state;
    expect(state.phase === "review" && state.step).toMatchObject({
      kind: "stopping",
      verdict: { kind: "pass", evidence: "All green" },
    });
  });

  test("a pass with no evidence is refused", () => {
    const run = more(testing(), [
      agent({ session: 5, role: "tester", kind: "pass", evidence: "" }),
    ]);
    expect(refused(run.last)).toBe("a pass needs evidence");
  });

  test("changes with no findings are refused", () => {
    const run = more(testing(), [
      agent({ session: 5, role: "tester", kind: "changes", findings: " " }),
    ]);
    expect(refused(run.last)).toBe("changes need findings");
  });

  test("a builder's done from the tester's session is refused", () => {
    const run = more(testing(), [
      agent({
        session: 5,
        role: "builder",
        kind: "done",
        commit: "c",
        files: [],
        work: { kind: "summary", text: "x" },
      }),
    ]);
    expect(refused(run.last)).toBe("session 5 is the tester, not the builder");
  });

  test("the old builder's session can't pass the review", () => {
    const run = more(testing(), [
      agent({ session: 2, role: "builder", kind: "pass", evidence: "ok" }),
    ]);
    expect(refused(run.last)).toBe("session 2 isn't the task's agent");
  });
});

describe("after the tester's stop", () => {
  test("its copy is removed", () => {
    const run = more(testing(), [
      changes(),
      plugin({ kind: "session_stopped", session: 5, save: "nothing" }),
    ]);
    expect(run.commands).toContainEqual({
      kind: "remove_workspace",
      task: "t1",
      path: "/w/t1-copy",
    });
    expect(types(run.events).slice(2, 4)).toEqual(["session.ended", "workspace.removed"]);
  });

  test("changes send the task back to build, and a fresh builder gets the findings", () => {
    const run = more(testing(), [
      changes(),
      plugin({ kind: "session_stopped", session: 5, save: "nothing" }),
    ]);
    expect(types(run.events).slice(-2)).toEqual(["phase.started", "session.requested"]);
    expect(run.commands.at(-1)).toMatchObject({
      kind: "start_session",
      request: 6,
      role: "builder",
      path: "/w/t1",
      handback: { kind: "findings", text: "No test for empty reports" },
    });
    const state = taskOf(run).state;
    expect(state.phase === "build" && [state.loops, state.workspace?.path]).toEqual([1, "/w/t1"]);
  });

  test("changes at the loop cap hold the task with the findings", () => {
    let run: Played = testing();
    for (let round = 1; round <= LOOP_CAP; round++) {
      const tester = taskOf(run).requests;
      run = more(run, [
        changes(tester),
        plugin({ kind: "session_stopped", session: tester, save: "nothing" }),
      ]);
      if (round === LOOP_CAP) break;
      const builder = taskOf(run).requests;
      run = more(run, [
        plugin({ kind: "session_started", request: builder, harnessId: "h" }),
        agent({
          session: builder,
          role: "builder",
          kind: "done",
          commit: "c",
          files: ["src/export.ts"],
          work: { kind: "summary", text: "Again" },
        }),
        plugin({ kind: "session_stopped", session: builder, save: "saved" }),
        plugin({
          kind: "main_merged",
          request: builder + 1,
          commit: "m",
          files: ["src/export.ts"],
        }),
        plugin({ kind: "workspace_created", request: builder + 2, path: `/w/copy${round}` }),
        plugin({ kind: "session_started", request: builder + 3, harnessId: "h" }),
      ]);
    }
    expect(types(run.events).slice(-2)).toEqual(["phase.started", "task.held"]);
    expect(run.commands.filter((c) => c.kind === "start_session")).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.loops).toBe(LOOP_CAP);
    expect(state.phase === "build" && state.hold).toEqual({
      kind: "loop_cap",
      findings: "No test for empty reports",
    });
  });
});

describe("found in review of the review part", () => {
  const stamp: { v: 1; task: string; at: number } = { v: 1, task: "t1", at: 99 };

  test("a start after a pass doesn't run review again", () => {
    const run = more(testing(), [
      pass(),
      plugin({ kind: "session_stopped", session: 5, save: "nothing" }),
      daemon({ kind: "start" }),
    ]);
    expect(refused(run.last)).toBe("task t1 isn't waiting for a slot");
  });

  test("replay refuses a second verdict for the same stop", () => {
    const task = taskOf(more(testing(), [pass()]));
    const second: Event = { ...stamp, type: "review.changes_requested", session: 5, findings: "x" };
    expect(evolve(task, second).ok).toBe(false);
  });

  test("replay refuses a verdict from a session that isn't stopping", () => {
    const task = taskOf(more(testing(), [pass()]));
    const other: Event = { ...stamp, type: "review.passed", session: 2, evidence: "x" };
    expect(evolve(task, other).ok).toBe(false);
  });

  test("replay refuses removing the task's workspace during review", () => {
    const task = taskOf(testing());
    const removed: Event = { ...stamp, type: "workspace.removed", request: 1 };
    expect(evolve(task, removed).ok).toBe(false);
  });
});
