import { describe, expect, test } from "bun:test";
import { agent, play, plugin, refused, taskOf, types, you } from "./testing";

describe("a new task", () => {
  test("add puts it in triage, waiting for a slot", () => {
    const run = play([you({ kind: "add", title: "Fix export", description: "It crashes" })]);
    expect(types(run.events)).toEqual(["task.received"]);
    expect(run.commands).toEqual([]);
    const task = taskOf(run);
    expect(task.title).toBe("Fix export");
    expect(task.source).toEqual({ kind: "local", id: "t1" });
    expect(task.requests).toBe(0);
    expect(task.state).toEqual({
      phase: "triage",
      overrides: {},
      step: { kind: "queued" },
      attached: false,
    });
  });

  test("a task source's arrival puts it in triage too", () => {
    const run = play([
      plugin({
        kind: "task_arrived",
        source: { kind: "github", id: "142" },
        title: "Fix export",
        description: "It crashes",
      }),
    ]);
    const task = taskOf(run);
    expect(task.source).toEqual({ kind: "github", id: "142" });
    expect(task.state.phase).toBe("triage");
  });

  test("add keeps intent, rigor or approval given alone, for triage to respect", () => {
    const run = play([
      you({ kind: "add", title: "Fix", description: "", intent: "try", approve: true }),
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "triage" && state.overrides).toEqual({ intent: "try", approve: true });
  });

  test("add with intent and rigor skips triage, with the title and description as brief", () => {
    const run = play([
      you({
        kind: "add",
        title: "Fix export",
        description: "It crashes",
        intent: "ship",
        rigor: "light",
      }),
    ]);
    expect(types(run.events)).toEqual(["task.received", "phase.started"]);
    expect(taskOf(run).state).toEqual({
      phase: "build",
      intent: "ship",
      rigor: "light",
      approve: false,
      brief: "Fix export\n\nIt crashes",
      loops: 0,
      step: { kind: "queued" },
      attached: false,
    });
  });

  test("every event carries the input's task and moment", () => {
    const add = you({ kind: "add", title: "Fix", description: "", intent: "ship", rigor: "full" });
    const run = play([add]);
    for (const event of run.events) {
      expect(event.task).toBe(add.task);
      expect(event.at).toBe(add.at);
      expect(event.v).toBe(1);
    }
  });

  test("a second add for the same task is refused", () => {
    const run = play([
      you({ kind: "add", title: "Fix", description: "" }),
      you({ kind: "add", title: "Again", description: "" }),
    ]);
    expect(refused(run.last)).toBe("task t1 already exists");
    expect(taskOf(run).title).toBe("Fix");
  });
});

describe("refused before the phase is looked at", () => {
  test("any other input for a task that doesn't exist", () => {
    const run = play([you({ kind: "pause" })]);
    expect(refused(run.last)).toBe("there is no task t1");
  });

  test("an outside change, which never moves a task", () => {
    const run = play([
      you({ kind: "add", title: "Fix", description: "" }),
      plugin({ kind: "outside_change", change: "closed" }),
    ]);
    expect(refused(run.last)).toBe(
      "the issue was closed in the tracker, but tasks move only through Skelcrew",
    );
  });

  test("an agent input from a session the task isn't running", () => {
    const run = play([
      you({ kind: "add", title: "Fix", description: "" }),
      agent({ session: 1, role: "planner", kind: "decline", reason: "No" }),
    ]);
    expect(refused(run.last)).toBe("session 1 isn't the task's agent");
  });
});
