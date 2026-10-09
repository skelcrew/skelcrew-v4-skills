import { describe, expect, test } from "bun:test";
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
import type { Intent } from "./types";

// Build, with triage skipped: workspace from request 1, builder session 2.
const starting = (intent: Intent = "ship") =>
  play([
    you({ kind: "add", title: "Fix export", description: "", intent, rigor: "full" }),
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
  ]);
const building = (intent: Intent = "ship") =>
  more(starting(intent), [plugin({ kind: "session_started", request: 2, harnessId: "h2" })]);

const stopped = (save: "saved" | "nothing" | "failed" = "saved", session = 2) =>
  plugin({ kind: "session_stopped", session, save });

const stateOf = (run: Played) => taskOf(run).state;

describe("pause and resume", () => {
  test("pausing a running builder stops it, saving its work", () => {
    const run = more(building(), [you({ kind: "pause" })]);
    expect(types(run.events)).toEqual(["task.paused", "session.stopping"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: true }]);
  });

  test("once the stop is confirmed, the paused task rests and no builder starts", () => {
    const run = more(building(), [you({ kind: "pause" }), stopped()]);
    expect(run.commands.filter((c) => c.kind === "start_session")).toEqual([]);
    const state = stateOf(run);
    expect(state.phase === "build" && [state.step, state.hold]).toEqual([
      { kind: "queued" },
      { kind: "paused" },
    ]);
  });

  test("a builder on an answer task is stopped without saving", () => {
    const run = more(building("answer"), [you({ kind: "pause" })]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: false }]);
  });

  test("pausing while the builder starts stops it as soon as it has started", () => {
    let run = more(starting(), [you({ kind: "pause" })]);
    expect(types(run.events)).toEqual(["task.paused"]);
    expect(run.commands).toEqual([]);
    run = more(run, [plugin({ kind: "session_started", request: 2, harnessId: "h2" })]);
    expect(types(run.events)).toEqual(["session.started", "session.stopping"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: true }]);
  });

  test("a workspace that finishes during a pause leaves the task resting", () => {
    const run = play([
      you({ kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" }),
      daemon({ kind: "start" }),
      you({ kind: "pause" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    ]);
    expect(run.commands.filter((c) => c.kind === "start_session")).toEqual([]);
    const state = stateOf(run);
    expect(state.phase === "build" && state.step).toEqual({ kind: "queued" });
  });

  test("resume lifts the pause, and the task waits for the scheduler", () => {
    const run = more(building(), [you({ kind: "pause" }), stopped(), you({ kind: "resume" })]);
    expect(types(run.events).at(-1)).toBe("task.resumed");
    const state = stateOf(run);
    expect(state.phase === "build" && [state.hold, state.lifted]).toEqual([
      undefined,
      { kind: "paused" },
    ]);
  });

  test("the next builder is told why it is back, and the reason is then dropped", () => {
    const run = more(building(), [
      you({ kind: "pause" }),
      stopped(),
      you({ kind: "resume" }),
      daemon({ kind: "start" }),
    ]);
    expect(run.commands.at(-1)).toMatchObject({ kind: "start_session", back: { kind: "paused" } });
    const state = stateOf(run);
    expect(state.phase === "build" && state.lifted).toBeUndefined();
  });

  test("pausing a paused task is refused", () => {
    const run = more(building(), [you({ kind: "pause" }), you({ kind: "pause" })]);
    expect(refused(run.last)).toBe("task t1 is already paused");
  });

  test("pausing a task held for a failure is refused, so the failure stays visible", () => {
    const run = more(building(), [
      agent({ session: 2, role: "builder", kind: "give_up", reason: "No creds" }),
      you({ kind: "pause" }),
    ]);
    expect(refused(run.last)).toBe("task t1 is already held: its agent gave up: No creds");
  });

  test("resume refuses a hold that isn't a pause", () => {
    const run = more(building(), [
      agent({ session: 2, role: "builder", kind: "give_up", reason: "No creds" }),
      you({ kind: "resume" }),
    ]);
    expect(refused(run.last)).toBe(
      "task t1 is held because its agent gave up: No creds. Retry it instead.",
    );
  });

  test("resume and retry refuse a task that isn't held", () => {
    expect(refused(more(building(), [you({ kind: "resume" })]).last)).toBe("task t1 isn't paused");
    expect(refused(more(building(), [you({ kind: "retry" })]).last)).toBe("task t1 isn't held");
  });
});

describe("failures", () => {
  test("a crash holds the task with its exit code, and the stop saves the work", () => {
    const run = more(building(), [
      plugin({ kind: "session_ended", session: 2, exitCode: 137, lastLine: "Killed" }),
    ]);
    expect(types(run.events)).toEqual(["task.held", "session.stopping"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: true }]);
    const state = stateOf(run);
    expect(state.phase === "build" && state.hold).toEqual({
      kind: "crashed",
      exitCode: 137,
      lastLine: "Killed",
    });
    expect(state.phase === "build" && state.step).toEqual({
      kind: "stopping",
      session: 2,
      reason: "crashed",
      save: true,
    });
  });

  test("a crash before the start reply is still a crash, and the late reply is ignored", () => {
    let run = more(starting(), [plugin({ kind: "session_ended", session: 2, lastLine: "gone" })]);
    expect(types(run.events)).toEqual(["task.held", "session.stopping"]);
    run = more(run, [plugin({ kind: "session_started", request: 2, harnessId: "h2" })]);
    expect(run.last).toEqual({ ok: true, events: [], commands: [] });
  });

  test("the crashed session's stop ends it as crashed", () => {
    const run = more(building(), [
      plugin({ kind: "session_ended", session: 2, exitCode: 1, lastLine: "panic" }),
      stopped(),
    ]);
    expect(run.events.at(-1)).toMatchObject({
      type: "session.ended",
      reason: "crashed",
      save: "saved",
    });
  });

  test("giving up holds the task with the reason and stops the agent", () => {
    const run = more(building(), [
      agent({ session: 2, role: "builder", kind: "give_up", reason: "No creds" }),
    ]);
    expect(types(run.events)).toEqual(["task.held", "session.stopping"]);
    const state = stateOf(run);
    expect(state.phase === "build" && state.hold).toEqual({ kind: "gave_up", reason: "No creds" });
  });

  test("giving up with no reason is refused", () => {
    const run = more(building(), [
      agent({ session: 2, role: "builder", kind: "give_up", reason: "" }),
    ]);
    expect(refused(run.last)).toBe("giving up needs a reason");
  });

  test("retry after a crash lets the scheduler start a fresh builder, told why", () => {
    const run = more(building(), [
      plugin({ kind: "session_ended", session: 2, exitCode: 1, lastLine: "panic" }),
      stopped(),
      you({ kind: "retry" }),
      daemon({ kind: "start" }),
    ]);
    expect(run.commands.at(-1)).toMatchObject({
      kind: "start_session",
      request: 3,
      role: "builder",
      back: { kind: "crashed", exitCode: 1, lastLine: "panic" },
    });
  });

  test("a failed save holds the task, and the workspace is marked unsaved", () => {
    const run = more(building(), [you({ kind: "pause" }), stopped("failed")]);
    const state = stateOf(run);
    expect(state.phase === "build" && [state.hold, state.workspace?.unsaved]).toEqual([
      { kind: "unsaved" },
      true,
    ]);
  });
});

describe("kill", () => {
  test("killing a running builder ends the task, stops the agent, and keeps its workspace until saved", () => {
    const run = more(building(), [you({ kind: "kill" })]);
    expect(types(run.events)).toEqual(["session.stopping", "task.killed"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: true }]);
    expect(stateOf(run)).toEqual({
      phase: "ended",
      outcome: { kind: "killed" },
      proposals: [],
      agent: { kind: "stopping", session: 2, reason: "stopped", save: true },
      workspace: { request: 1, path: "/w/t1", branch: "skel/t1-fix-export", unsaved: false },
    });
  });

  test("once the stop is saved, the workspace goes and the branch stays", () => {
    const run = more(building(), [you({ kind: "kill" }), stopped()]);
    expect(run.commands.at(-1)).toEqual({ kind: "remove_workspace", task: "t1", path: "/w/t1" });
  });

  test("if the killed builder's save fails, the workspace is kept for good", () => {
    const killed = more(building(), [you({ kind: "kill" })]);
    const run = more(killed, [stopped("failed")]);
    expect(run.commands).toEqual([]);
    const state = stateOf(run);
    expect(state.phase === "ended" && [state.agent, state.workspace?.unsaved]).toEqual([
      undefined,
      true,
    ]);
  });

  test("a task with no agent at work loses its workspace at once", () => {
    const paused = more(building(), [you({ kind: "pause" }), stopped()]);
    const run = more(paused, [you({ kind: "kill" })]);
    expect(types(run.events)).toEqual(["task.killed", "workspace.removed"]);
    expect(stateOf(run)).toEqual({ phase: "ended", outcome: { kind: "killed" }, proposals: [] });
  });

  test("an unsaved workspace is never removed", () => {
    const unsaved = more(building(), [you({ kind: "pause" }), stopped("failed")]);
    const run = more(unsaved, [you({ kind: "kill" })]);
    expect(run.commands).toEqual([]);
    const state = stateOf(run);
    expect(state.phase === "ended" && state.workspace?.unsaved).toBe(true);
  });

  test("killing a task held at the loop cap ends it as failed", () => {
    let run = building();
    for (let round = 0; round < 3; round++) {
      const builder = taskOf(run).requests;
      run = more(run, [
        agent({
          session: builder,
          role: "builder",
          kind: "done",
          commit: "c",
          files: [],
          work: { kind: "summary", text: "x" },
        }),
        stopped("saved", builder),
        plugin({ kind: "main_conflict", request: builder + 1 }),
      ]);
      if (round < 2) {
        run = more(run, [
          plugin({ kind: "session_started", request: builder + 2, harnessId: "h" }),
        ]);
      }
    }
    run = more(run, [you({ kind: "kill" })]);
    expect(types(run.events)[0]).toBe("task.failed");
    const state = stateOf(run);
    expect(state.phase === "ended" && state.outcome).toEqual({ kind: "failed" });
  });

  test("killing while the builder starts stops it once it has started, then removes the workspace", () => {
    let run = more(starting(), [you({ kind: "kill" })]);
    expect(stateOf(run)).toMatchObject({ agent: { kind: "starting", request: 2 } });
    run = more(run, [plugin({ kind: "session_started", request: 2, harnessId: "h2" })]);
    expect(types(run.events)).toEqual(["session.started", "session.stopping"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: true }]);
    run = more(run, [stopped()]);
    expect(run.commands).toEqual([{ kind: "remove_workspace", task: "t1", path: "/w/t1" }]);
  });

  test("killing while the builder starts, then the start fails, removes the workspace", () => {
    const killed = more(starting(), [you({ kind: "kill" })]);
    const run = more(killed, [plugin({ kind: "session_failed", request: 2, error: "no tmux" })]);
    expect(types(run.events)).toEqual(["session.failed", "workspace.removed"]);
    expect(stateOf(run)).toEqual({ phase: "ended", outcome: { kind: "killed" }, proposals: [] });
  });

  test("killing a task twice is refused", () => {
    const run = more(building(), [you({ kind: "kill" }), you({ kind: "kill" })]);
    expect(refused(run.last)).toBe("task t1 has ended");
  });
});

describe("only a stop that saves says anything about saving", () => {
  // Review with an unsaved workspace: the builder's stop after done fails
  // to save, you retry, main merges, and the tester runs in its copy.
  const reviewingUnsaved = () =>
    more(building(), [
      agent({
        session: 2,
        role: "builder",
        kind: "done",
        commit: "c1",
        files: ["src/export.ts"],
        work: { kind: "summary", text: "x" },
      }),
      stopped("failed"),
      you({ kind: "retry" }),
      daemon({ kind: "start" }),
      plugin({ kind: "main_merged", request: 3, commit: "m3", files: ["src/export.ts"] }),
      plugin({ kind: "workspace_created", request: 4, path: "/w/copy" }),
      plugin({ kind: "session_started", request: 5, harnessId: "h5" }),
    ]);

  test("the tester's stop never clears the unsaved mark on the task's workspace", () => {
    const run = more(reviewingUnsaved(), [you({ kind: "kill" }), stopped("nothing", 5)]);
    expect(run.commands).not.toContainEqual({
      kind: "remove_workspace",
      task: "t1",
      path: "/w/t1",
    });
    expect(run.commands).toContainEqual({ kind: "remove_workspace", task: "t1", path: "/w/copy" });
    const state = stateOf(run);
    expect(state.phase === "ended" && state.workspace?.unsaved).toBe(true);
  });

  test("a failed save reported for a stop that doesn't save holds nothing", () => {
    const run = more(reviewingUnsaved(), [
      agent({ session: 5, role: "tester", kind: "pass", evidence: "ok" }),
      stopped("failed", 5),
    ]);
    expect(types(run.events)).not.toContain("task.held");
    expect(run.commands.at(-1)?.kind).toBe("deliver_output");
  });

  test("a held task's output is not delivered, even once you approve it", () => {
    const run = more(reviewingUnsaved(), [
      you({ kind: "pause" }),
      agent({ session: 5, role: "tester", kind: "pass", evidence: "ok" }),
    ]);
    expect(refused(run.last)).toBe("session 5 isn't the task's agent");
    const paused = more(reviewingUnsaved(), [
      agent({ session: 5, role: "tester", kind: "pass", evidence: "ok" }),
      you({ kind: "pause" }),
      stopped("nothing", 5),
    ]);
    expect(paused.commands.filter((c) => c.kind === "deliver_output")).toEqual([]);
    const state = stateOf(paused);
    expect(state.phase === "review" && state.step.kind).toBe("ready");
    const resumed = more(paused, [you({ kind: "resume" })]);
    expect(resumed.commands.map((c) => c.kind)).toEqual(["deliver_output"]);
  });
});
