import { describe, expect, test } from "bun:test";
import { agent, daemon, more, play, plugin, refused, taskOf, types, you } from "./testing";
import type { Intent } from "./types";

// A builder at work: workspace 1, session 2.
const building = (intent: Intent = "ship") =>
  play([
    you({ kind: "add", title: "Fix export", description: "", intent, rigor: "full" }),
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
  ]);

const attached = (intent: Intent = "ship") => more(building(intent), [you({ kind: "attach" })]);
const handOver = () =>
  you({ kind: "detach", choice: "hand_over", commit: "c-you", files: ["src/export.ts"] });

describe("attach", () => {
  test("attaching to a running session is recorded, and the agent carries on", () => {
    const run = attached();
    expect(types(run.events)).toEqual(["session.attached"]);
    expect(run.commands).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && [state.attached, state.step.kind]).toEqual([true, "running"]);
  });

  test("the agent is still heard while you are attached", () => {
    const run = more(attached(), [
      agent({ session: 2, role: "builder", kind: "progress", text: "hi" }),
    ]);
    expect(types(run.events)).toEqual(["progress.reported"]);
  });

  test("attaching twice is refused", () => {
    const run = more(attached(), [you({ kind: "attach" })]);
    expect(refused(run.last)).toBe("you are already attached to task t1");
  });

  test("attaching with no running session is refused", () => {
    const run = play([
      you({ kind: "add", title: "Fix", description: "" }),
      you({ kind: "attach" }),
    ]);
    expect(refused(run.last)).toBe("task t1 has no running session to attach to");
  });

  test("a crash takes your attachment with it", () => {
    const run = more(attached(), [
      plugin({ kind: "session_ended", session: 2, exitCode: 1, lastLine: "panic" }),
      you({ kind: "detach", choice: "resume" }),
    ]);
    expect(refused(run.last)).toBe("you aren't attached to task t1");
  });
});

describe("detach", () => {
  test("detaching to resume hands the task back to its agent", () => {
    const run = more(attached(), [you({ kind: "detach", choice: "resume" })]);
    expect(types(run.events)).toEqual(["session.detached"]);
    expect(run.commands).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && [state.attached, state.step.kind]).toEqual([
      false,
      "running",
    ]);
  });

  test("detaching to hand over treats the work as done, by you", () => {
    const run = more(attached(), [handOver()]);
    expect(types(run.events)).toEqual(["session.detached", "session.stopping", "build.done"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: true }]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.step).toMatchObject({
      kind: "stopping",
      handover: {
        intent: "ship",
        commit: "c-you",
        files: ["src/export.ts"],
        by: "you",
        work: { kind: "summary", text: "Handed over by you." },
      },
    });
  });

  test("after a hand over, the task merges main once the stop is confirmed", () => {
    const run = more(attached(), [
      handOver(),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }),
    ]);
    expect(run.commands.at(-1)).toMatchObject({ kind: "merge_main", request: 3 });
  });

  test("handing over an answer is refused, since it needs the builder's report", () => {
    const run = more(attached("answer"), [handOver()]);
    expect(refused(run.last)).toBe(
      "an answer needs the builder's report, so it can't be handed over. Detach with resume.",
    );
  });

  test("handing over outside build is refused", () => {
    const run = play([
      you({ kind: "add", title: "Fix", description: "" }),
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
      you({ kind: "attach" }),
      handOver(),
    ]);
    expect(refused(run.last)).toBe("only a builder's work can be handed over");
  });

  test("detaching when not attached is refused", () => {
    const run = more(building(), [you({ kind: "detach", choice: "resume" })]);
    expect(refused(run.last)).toBe("you aren't attached to task t1");
  });
});
