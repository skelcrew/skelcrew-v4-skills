import { describe, expect, test } from "bun:test";
import { evolve } from "./evolve";
import { agent, daemon, more, play, plugin, refused, taskOf, types, you } from "./testing";
import type { Event, Intent, Work } from "./types";

// A task added with intent and rigor, so triage is skipped, and its builder
// at work: workspace from request 1, builder session 2.
const building = (intent: Intent = "ship") =>
  play([
    you({ kind: "add", title: "Fix export", description: "It crashes", intent, rigor: "full" }),
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
  ]);

const summary: Work = { kind: "summary", text: "Headers on empty reports" };
const report: Work = { kind: "report", text: "Search is slow because...", proposals: [] };

const done = (work: Work = summary, files = ["src/export.ts"]) =>
  agent({ session: 2, role: "builder", kind: "done", commit: "c1", files, work });

const stopped = (session = 2) => plugin({ kind: "session_stopped", session, save: "saved" });

describe("starting build", () => {
  test("with triage skipped, the start asks for the workspace, then the builder", () => {
    const run = building();
    expect(types(run.events)).toEqual([
      "task.received",
      "phase.started",
      "workspace.requested",
      "workspace.created",
      "session.requested",
      "session.started",
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "start_session",
      task: "t1",
      request: 2,
      role: "builder",
      path: "/w/t1",
      edits: true,
      intent: "ship",
      rigor: "full",
      brief: "Fix export\n\nIt crashes",
    });
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.step).toEqual({
      kind: "running",
      session: 2,
      intent: "ship",
    });
  });

  test("a builder on an answer task can't edit", () => {
    const start = building("answer").commands.find((c) => c.kind === "start_session");
    expect(start?.kind === "start_session" && start.edits).toBe(false);
  });
});

describe("while the builder works", () => {
  test("progress is kept in the log and changes nothing else", () => {
    const before = building();
    const run = more(before, [
      agent({ session: 2, role: "builder", kind: "progress", text: "Found it" }),
    ]);
    expect(run.events).toMatchObject([{ type: "progress.reported", session: 2, text: "Found it" }]);
    expect(run.commands).toEqual([]);
    expect(taskOf(run)).toEqual(taskOf(before));
  });

  test("done stops the builder, saving, and fixes the handed-over work", () => {
    const run = more(building(), [done()]);
    expect(types(run.events)).toEqual(["session.stopping", "build.done"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: true }]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.step).toEqual({
      kind: "stopping",
      session: 2,
      reason: "reported",
      handover: {
        intent: "ship",
        commit: "c1",
        files: ["src/export.ts"],
        by: "builder",
        work: summary,
      },
    });
  });

  test("an answer builder's stop doesn't save", () => {
    const run = more(building("answer"), [done(report)]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: false }]);
  });

  test("a report on a ship task is refused", () => {
    const run = more(building(), [done(report)]);
    expect(refused(run.last)).toBe("a ship task hands over a summary, not a report");
  });

  test("a summary on an answer task is refused", () => {
    const run = more(building("answer"), [done(summary)]);
    expect(refused(run.last)).toBe("an answer task hands over a report, not a summary");
  });

  test("a second done while the first one's stop is in flight is refused", () => {
    const run = more(building(), [done(), done()]);
    expect(refused(run.last)).toBe("session 2 isn't the task's agent");
  });

  test("a tester's verdict from the builder's session is refused", () => {
    const run = more(building(), [
      agent({ session: 2, role: "tester", kind: "pass", evidence: "ok" }),
    ]);
    expect(refused(run.last)).toBe("session 2 is the builder, not the tester");
  });
});

describe("after the builder's stop", () => {
  test("ship merges main into the workspace", () => {
    const run = more(building(), [done(), stopped()]);
    expect(types(run.events)).toEqual([
      "session.stopping",
      "build.done",
      "session.ended",
      "main.requested",
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "merge_main",
      task: "t1",
      request: 3,
      path: "/w/t1",
    });
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.step.kind).toBe("merging");
  });

  test("an answer goes to review on the handed-over commit", () => {
    const run = more(building("answer"), [done(report, ["docs/notes.md"]), stopped()]);
    expect(types(run.events).slice(-3)).toEqual([
      "session.ended",
      "phase.started",
      "workspace.requested",
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "review" && state.reviewed).toEqual({
      commit: "c1",
      files: ["docs/notes.md"],
    });
    expect(state.phase === "review" && state.handover.work).toEqual(report);
  });

  test("a merge moves a ship task to review on the merged commit", () => {
    const run = more(building(), [
      done(),
      stopped(),
      plugin({
        kind: "main_merged",
        request: 3,
        commit: "m3",
        files: ["src/export.ts", "README.md"],
      }),
    ]);
    expect(types(run.events).slice(-3)).toEqual([
      "main.merged",
      "phase.started",
      "workspace.requested",
    ]);
    const state = taskOf(run).state;
    expect(state.phase).toBe("review");
    expect(state.phase === "review" && state.reviewed).toEqual({
      commit: "m3",
      files: ["src/export.ts", "README.md"],
    });
    expect(state.phase === "review" && [state.intent, state.loops, state.workspace.path]).toEqual([
      "ship",
      0,
      "/w/t1",
    ]);
  });
});

describe("a merge that doesn't go through", () => {
  const merging = () => more(building(), [done(), stopped()]);

  test("a conflict counts as a loop, and a fresh builder gets the merge back", () => {
    const run = more(merging(), [plugin({ kind: "main_conflict", request: 3 })]);
    expect(types(run.events)).toEqual(["main.conflict", "session.requested"]);
    expect(run.commands.at(-1)).toMatchObject({
      kind: "start_session",
      request: 4,
      role: "builder",
      handback: { kind: "conflict" },
    });
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.loops).toBe(1);
  });

  test("a conflict at the loop cap holds the task", () => {
    let run = merging();
    for (let round = 0; round < 2; round++) {
      const request = taskOf(run).requests;
      run = more(run, [
        plugin({ kind: "main_conflict", request }),
        plugin({ kind: "session_started", request: request + 1, harnessId: "h" }),
        agent({
          session: request + 1,
          role: "builder",
          kind: "done",
          commit: "c",
          files: [],
          work: summary,
        }),
        stopped(request + 1),
      ]);
    }
    const request = taskOf(run).requests;
    run = more(run, [plugin({ kind: "main_conflict", request })]);
    expect(types(run.events)).toEqual(["main.conflict", "task.held"]);
    expect(run.commands).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.loops).toBe(3);
    expect(state.phase === "build" && state.hold).toEqual({
      kind: "loop_cap",
      findings: "merging main conflicted",
    });
  });

  test("a failed merge holds the task, keeping the handed-over work", () => {
    const run = more(merging(), [plugin({ kind: "main_failed", request: 3, error: "index.lock" })]);
    expect(types(run.events)).toEqual(["main.failed", "task.held"]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.step.kind).toBe("queued");
    expect(state.phase === "build" && "handover" in state.step && state.step.handover?.commit).toBe(
      "c1",
    );
    expect(state.phase === "build" && state.hold).toEqual({
      kind: "failed",
      what: "merge",
      error: "index.lock",
    });
  });
});

describe("found in review of build", () => {
  const stamp: { v: 1; task: string; at: number } = { v: 1, task: "t1", at: 99 };

  test("after conflicts reach the cap, the hold says why in plain words", () => {
    let run = more(building(), [done(), stopped()]);
    for (let round = 0; round < 3; round++) {
      const request = taskOf(run).requests;
      run = more(run, [plugin({ kind: "main_conflict", request })]);
      if (round === 2) break;
      run = more(run, [
        plugin({ kind: "session_started", request: request + 1, harnessId: "h" }),
        agent({
          session: request + 1,
          role: "builder",
          kind: "done",
          commit: "c",
          files: [],
          work: summary,
        }),
        stopped(request + 1),
      ]);
    }
    run = more(run, [daemon({ kind: "start" })]);
    expect(refused(run.last)).toBe(
      "task t1 is held: the loop cap was reached: merging main conflicted",
    );
  });

  test("replay refuses review starting while the builder still runs", () => {
    const review: Event = {
      ...stamp,
      type: "phase.started",
      phase: "review",
      handover: { intent: "ship", commit: "c1", files: [], by: "builder", work: summary },
      reviewed: { commit: "c1", files: [] },
    };
    expect(evolve(taskOf(building()), review).ok).toBe(false);
  });

  test("replay refuses a merge reply that answers another request", () => {
    const task = taskOf(more(building(), [done(), stopped()]));
    const merged: Event = { ...stamp, type: "main.merged", request: 9, commit: "m", files: [] };
    expect(evolve(task, merged).ok).toBe(false);
  });
});
