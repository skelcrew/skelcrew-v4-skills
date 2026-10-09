import { describe, expect, test } from "bun:test";
import { holdsSlot, schedule, slotsInUse, taskUsage } from "./schedule";
import {
  agent,
  config,
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
import type { Task } from "./types";

const add = (task: string) =>
  you({ kind: "add", title: `Task ${task}`, description: "", intent: "ship", rigor: "full" }, task);

// Starts a builder on a task already added: workspace 1, session 2.
const startBuilder = (run: Played, task: string) =>
  more(run, [
    daemon({ kind: "start" }, task),
    plugin({ kind: "workspace_created", request: 1, path: `/w/${task}` }, task),
    plugin({ kind: "session_started", request: 2, harnessId: "h" }, task),
  ]);

const tasksOf = (run: Played): Task[] => [...run.tasks.values()];
const picks = (run: Played) => schedule(tasksOf(run), config, 99).map((i) => [i.task, i.kind]);

describe("which tasks hold a slot", () => {
  test("a queued task holds none, a starting or running one holds one", () => {
    let run = play([add("t1")]);
    expect(holdsSlot(taskOf(run))).toBe(false);
    run = more(run, [daemon({ kind: "start" })]);
    expect(holdsSlot(taskOf(run))).toBe(true);
    run = startBuilder(play([add("t1")]), "t1");
    expect(holdsSlot(taskOf(run))).toBe(true);
  });

  test("an open question frees the slot, unless you are attached", () => {
    const asked = more(startBuilder(play([add("t1")]), "t1"), [
      agent({ session: 2, role: "builder", kind: "ask", text: "?", options: [] }),
    ]);
    expect(holdsSlot(taskOf(asked))).toBe(false);
    expect(holdsSlot(taskOf(more(asked, [you({ kind: "attach" })])))).toBe(true);
  });

  test("a stop in flight holds the slot, even while the task is paused", () => {
    const run = more(startBuilder(play([add("t1")]), "t1"), [you({ kind: "pause" })]);
    expect(holdsSlot(taskOf(run))).toBe(true);
    const done = more(run, [plugin({ kind: "session_stopped", session: 2, save: "saved" })]);
    expect(holdsSlot(taskOf(done))).toBe(false);
  });

  test("an ended task holds a slot while its agent's stop is in flight", () => {
    const run = more(startBuilder(play([add("t1")]), "t1"), [you({ kind: "kill" })]);
    expect(holdsSlot(taskOf(run))).toBe(true);
    const done = more(run, [plugin({ kind: "session_stopped", session: 2, save: "saved" })]);
    expect(holdsSlot(taskOf(done))).toBe(false);
  });
});

describe("the scheduler", () => {
  test("starts queued tasks oldest first, up to max_running", () => {
    const run = play([add("t1"), add("t2"), add("t3")]);
    expect(picks(run)).toEqual([
      ["t1", "start"],
      ["t2", "start"],
    ]);
  });

  test("starts nothing while every slot is taken", () => {
    let run = play([add("t1"), add("t2"), add("t3")]);
    run = startBuilder(run, "t1");
    run = startBuilder(run, "t2");
    expect(slotsInUse(tasksOf(run))).toBe(2);
    expect(picks(run)).toEqual([]);
  });

  test("answers come first, then resumed tasks, then queued ones", () => {
    let run = play([add("t1"), add("t2"), add("t3"), add("t4")]);
    // t2 is paused and resumed. t3 asks, and you answer.
    run = startBuilder(run, "t2");
    run = more(run, [
      you({ kind: "pause" }, "t2"),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }, "t2"),
      you({ kind: "resume" }, "t2"),
    ]);
    run = startBuilder(run, "t3");
    run = more(run, [
      agent({ session: 2, role: "builder", kind: "ask", text: "?", options: [] }, "t3"),
      you({ kind: "reply", question: 1, text: "yes" }, "t3"),
    ]);
    expect(slotsInUse(tasksOf(run))).toBe(0);
    expect(
      schedule(tasksOf(run), { ...config, maxRunning: 4 }, 99).map((i) => [i.task, i.kind]),
    ).toEqual([
      ["t3", "deliver_answer"],
      ["t2", "start"],
      ["t1", "start"],
      ["t4", "start"],
    ]);
  });

  test("leaves a held task alone, and an attached task's answer for you to give", () => {
    let run = play([add("t1"), add("t2")]);
    run = more(run, [you({ kind: "pause" }, "t1")]);
    run = startBuilder(run, "t2");
    run = more(run, [
      agent({ session: 2, role: "builder", kind: "ask", text: "?", options: [] }, "t2"),
      you({ kind: "reply", question: 1, text: "yes" }, "t2"),
      you({ kind: "attach" }, "t2"),
    ]);
    expect(picks(run)).toEqual([]);
  });

  test("each input it returns carries the moment it was given", () => {
    const [first] = schedule(tasksOf(play([add("t1")])), config, 1234);
    expect(first).toEqual({ sender: "daemon", task: "t1", at: 1234, kind: "start" });
  });
});

describe("start now", () => {
  test("starts a queued task past max_running", () => {
    let run = play([add("t1"), add("t2"), add("t3")]);
    run = startBuilder(run, "t1");
    run = startBuilder(run, "t2");
    run = more(run, [you({ kind: "start" }, "t3")]);
    expect(types(run.events)).toEqual(["task.started", "workspace.requested"]);
    expect(slotsInUse(tasksOf(run))).toBe(3);
  });

  test("lifts a hold and starts the task", () => {
    const run = more(play([add("t1")]), [you({ kind: "pause" }), you({ kind: "start" })]);
    expect(types(run.events).slice(-2)).toEqual(["task.started", "workspace.requested"]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && [state.hold, state.lifted]).toEqual([
      undefined,
      { kind: "paused" },
    ]);
  });

  test("delivers a kept answer at once", () => {
    const run = more(startBuilder(play([add("t1")]), "t1"), [
      agent({ session: 2, role: "builder", kind: "ask", text: "?", options: [] }),
      you({ kind: "reply", question: 1, text: "yes" }),
      you({ kind: "start" }),
    ]);
    expect(types(run.events).slice(-2)).toEqual(["task.started", "answer.delivered"]);
  });

  test("is refused for a task waiting on your answer", () => {
    const run = more(startBuilder(play([add("t1")]), "t1"), [
      agent({ session: 2, role: "builder", kind: "ask", text: "?", options: [] }),
      you({ kind: "start" }),
    ]);
    expect(refused(run.last)).toBe("task t1 waits for your answer");
  });

  test("is refused for a task already under way", () => {
    const run = more(startBuilder(play([add("t1")]), "t1"), [you({ kind: "start" })]);
    expect(refused(run.last)).toBe("task t1 is already under way");
  });
});

describe("usage", () => {
  const usage = { input: 10, output: 5, cacheWrite: 1, cacheRead: 100, minutes: 2 };
  const running = () => startBuilder(play([add("t1")]), "t1");

  test("a session's growing totals are recorded, and the task's usage is their sum", () => {
    const run = more(running(), [daemon({ kind: "usage", session: 2, usage })]);
    expect(types(run.events)).toEqual(["usage.reported"]);
    expect(taskUsage(taskOf(run))).toEqual(usage);
  });

  test("a report lower than the last is older, and is refused", () => {
    const run = more(running(), [
      daemon({ kind: "usage", session: 2, usage }),
      daemon({ kind: "usage", session: 2, usage: { ...usage, output: 4 } }),
    ]);
    expect(refused(run.last)).toBe("usage for session 2 went down, so this report is older");
  });

  test("a report equal to the last records nothing", () => {
    const run = more(running(), [
      daemon({ kind: "usage", session: 2, usage }),
      daemon({ kind: "usage", session: 2, usage }),
    ]);
    expect(run.last).toEqual({ ok: true, events: [], commands: [] });
  });

  test("a report for a session the task never started is refused", () => {
    const run = more(running(), [daemon({ kind: "usage", session: 7, usage })]);
    expect(refused(run.last)).toBe("task t1 never started session 7");
  });

  test("usage is still taken after the task has ended", () => {
    const run = more(running(), [
      you({ kind: "kill" }),
      daemon({ kind: "usage", session: 2, usage }),
    ]);
    expect(types(run.events).at(-1)).toBe("usage.reported");
  });
});

describe("found in review of the scheduler", () => {
  // t1 asks, so it holds no slot. The scheduler then fills both slots.
  const full = () => {
    let run = startBuilder(play([add("t1"), add("t2"), add("t3")]), "t1");
    run = more(run, [agent({ session: 2, role: "builder", kind: "ask", text: "?", options: [] })]);
    run = startBuilder(run, "t2");
    return startBuilder(run, "t3");
  };

  test("a stop that took a slot only to clean up doesn't start new work past the limit", () => {
    const run = more(full(), [
      you({ kind: "set", intent: "try" }),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }),
    ]);
    expect(run.commands.filter((c) => c.kind === "start_session")).toEqual([]);
    expect(slotsInUse(tasksOf(run))).toBe(2);
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.step.kind).toBe("queued");
  });

  test("a crash, then a retry while the stop is in flight, waits for the scheduler too", () => {
    const run = more(full(), [
      plugin({ kind: "session_ended", session: 2, exitCode: 1, lastLine: "panic" }),
      you({ kind: "retry" }),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }),
    ]);
    expect(run.commands.filter((c) => c.kind === "start_session")).toEqual([]);
    expect(slotsInUse(tasksOf(run))).toBe(2);
  });

  test("a stop that kept its slot moves straight on, as before", () => {
    const run = more(startBuilder(play([add("t1")]), "t1"), [
      you({ kind: "set", intent: "try" }),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }),
    ]);
    expect(run.commands.map((c) => c.kind)).toEqual(["stop_session", "start_session"]);
  });

  const usage = { input: 10, output: 5, cacheWrite: 3, cacheRead: 100, minutes: 4 };

  test.each(["input", "output", "cacheWrite", "cacheRead", "minutes"] as const)(
    "a report with lower %s is refused",
    (field) => {
      const run = more(startBuilder(play([add("t1")]), "t1"), [
        daemon({ kind: "usage", session: 2, usage }),
        daemon({ kind: "usage", session: 2, usage: { ...usage, [field]: usage[field] - 1 } }),
      ]);
      expect(refused(run.last)).toBe("usage for session 2 went down, so this report is older");
    },
  );

  test("a task's usage sums every field over all its sessions", () => {
    const run = more(startBuilder(play([add("t1")]), "t1"), [
      daemon({ kind: "usage", session: 2, usage }),
      you({ kind: "set", intent: "try" }),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }),
      plugin({ kind: "session_started", request: 3, harnessId: "h3" }),
      daemon({ kind: "usage", session: 3, usage }),
    ]);
    expect(taskUsage(taskOf(run))).toEqual({
      input: 20,
      output: 10,
      cacheWrite: 6,
      cacheRead: 200,
      minutes: 8,
    });
  });
});
