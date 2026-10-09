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
import type { Work } from "./types";

const summary: Work = { kind: "summary", text: "Headers" };
const stopped = (session: number, save: "saved" | "nothing" = "saved") =>
  plugin({ kind: "session_stopped", session, save });
const phaseOf = (run: Played) => taskOf(run).state.phase;
const startsOf = (run: Played) => run.commands.filter((c) => c.kind === "start_session");

// Triage: workspace 1, planner session 2.
const triage = () => play([you({ kind: "add", title: "Fix export", description: "" })]);
const planning = () =>
  more(triage(), [
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
  ]);

// Build, triage skipped: workspace 1, builder session 2.
const building = () =>
  play([
    you({ kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" }),
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
  ]);
const done = () =>
  agent({
    session: 2,
    role: "builder",
    kind: "done",
    commit: "c1",
    files: ["src/x.ts"],
    work: summary,
  });
// Merge is request 3, the tester's copy 4, the tester 5.
const merging = () => more(building(), [done(), stopped(2)]);
const reviewing = () =>
  more(merging(), [
    plugin({ kind: "main_merged", request: 3, commit: "m3", files: ["src/x.ts"] }),
    plugin({ kind: "workspace_created", request: 4, path: "/w/copy" }),
    plugin({ kind: "session_started", request: 5, harnessId: "h5" }),
  ]);
const pass = () => agent({ session: 5, role: "tester", kind: "pass", evidence: "ok" });

test("a set that names nothing is refused", () => {
  expect(refused(more(building(), [you({ kind: "set" })]).last)).toBe(
    "name an intent, rigor or approval to change",
  );
});

describe("during triage", () => {
  test("intent and rigor on a queued task start build at once, waiting for a slot", () => {
    const run = more(triage(), [you({ kind: "set", intent: "ship", rigor: "light" })]);
    expect(types(run.events)).toEqual(["task.set", "phase.started"]);
    expect(run.commands).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && [state.intent, state.rigor, state.brief]).toEqual([
      "ship",
      "light",
      "Fix export",
    ]);
  });

  test("intent alone is kept for when the planner proceeds", () => {
    const run = more(planning(), [you({ kind: "set", intent: "try" })]);
    expect(types(run.events)).toEqual(["task.set"]);
    const state = taskOf(run).state;
    expect(state.phase === "triage" && state.overrides).toEqual({ intent: "try" });
  });

  test("intent and rigor stop a running planner, then build starts with a builder", () => {
    let run = more(planning(), [you({ kind: "set", intent: "ship", rigor: "light" })]);
    expect(types(run.events)).toEqual(["task.set", "session.stopping"]);
    run = more(run, [stopped(2, "nothing")]);
    expect(types(run.events)).toEqual(["session.ended", "phase.started", "session.requested"]);
    expect(run.commands).toEqual([
      expect.objectContaining({
        kind: "start_session",
        role: "builder",
        edits: true,
        path: "/w/t1",
      }),
    ]);
  });

  test("set while the workspace is made: once it exists, build starts", () => {
    const run = more(triage(), [
      daemon({ kind: "start" }),
      you({ kind: "set", intent: "answer", rigor: "light" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    ]);
    expect(phaseOf(run)).toBe("build");
    expect(startsOf(run)).toEqual([expect.objectContaining({ role: "builder", edits: false })]);
  });

  test("set while the planner starts: once it has started, it is stopped", () => {
    const run = more(triage(), [
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      you({ kind: "set", intent: "ship", rigor: "light" }),
      plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
    ]);
    expect(types(run.events).slice(-2)).toEqual(["session.started", "session.stopping"]);
  });
});

describe("a change of intent during build", () => {
  test("stops the running builder, saving, and a fresh one starts with the new permissions", () => {
    let run = more(building(), [you({ kind: "set", intent: "answer" })]);
    expect(types(run.events)).toEqual(["task.set", "session.stopping"]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 2, save: true }]);
    run = more(run, [stopped(2)]);
    expect(startsOf(run)).toEqual([
      expect.objectContaining({ request: 3, role: "builder", intent: "answer", edits: false }),
    ]);
  });

  test("a set to the same intent changes nothing else", () => {
    const run = more(building(), [you({ kind: "set", intent: "ship" })]);
    expect(types(run.events)).toEqual(["task.set"]);
  });

  test("a builder that was starting is stopped once it has started", () => {
    const run = play([
      you({ kind: "add", title: "Fix", description: "", intent: "ship", rigor: "full" }),
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      you({ kind: "set", intent: "try" }),
      plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
    ]);
    expect(types(run.events).slice(-2)).toEqual(["session.started", "session.stopping"]);
  });

  test("work handed over for the old intent isn't merged", () => {
    const run = more(building(), [done(), you({ kind: "set", intent: "try" }), stopped(2)]);
    expect(run.commands.filter((c) => c.kind === "merge_main")).toEqual([]);
    expect(startsOf(run)).toEqual([expect.objectContaining({ role: "builder", intent: "try" })]);
  });

  test("a merge that finishes after the change goes back to a fresh builder", () => {
    const run = more(merging(), [
      you({ kind: "set", intent: "answer" }),
      plugin({ kind: "main_merged", request: 3, commit: "m3", files: ["src/x.ts"] }),
    ]);
    expect(phaseOf(run)).toBe("build");
    expect(startsOf(run)).toEqual([expect.objectContaining({ role: "builder", edits: false })]);
  });
});

describe("a change of intent during review", () => {
  test("stops the tester without saving, removes its copy, and goes back to build", () => {
    let run = more(reviewing(), [you({ kind: "set", intent: "try" })]);
    expect(run.commands).toEqual([{ kind: "stop_session", task: "t1", session: 5, save: false }]);
    run = more(run, [stopped(5, "nothing")]);
    expect(run.commands.map((c) => c.kind)).toEqual(["remove_workspace", "start_session"]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && [state.intent, state.loops]).toEqual(["try", 0]);
  });

  test("a pass reported for the old intent is set aside", () => {
    const run = more(reviewing(), [
      pass(),
      you({ kind: "set", intent: "answer" }),
      stopped(5, "nothing"),
    ]);
    expect(run.commands.filter((c) => c.kind === "deliver_output")).toEqual([]);
    expect(phaseOf(run)).toBe("build");
  });

  test("a task waiting for your approval goes back to build, waiting for a slot", () => {
    const run = more(reviewing(), [
      you({ kind: "set", approve: true }),
      pass(),
      stopped(5, "nothing"),
      you({ kind: "set", intent: "try" }),
    ]);
    expect(types(run.events).slice(-2)).toEqual(["task.set", "phase.started"]);
    expect(run.commands.at(-1)?.kind).toBe("remove_workspace");
  });

  test("a delivery in flight carries on, and the task is done", () => {
    const run = more(reviewing(), [
      pass(),
      stopped(5, "nothing"),
      you({ kind: "set", intent: "try" }),
      plugin({ kind: "output_delivered", request: 6 }),
    ]);
    expect(phaseOf(run)).toBe("ended");
  });

  test("a delivery that fails after the change goes back to build, still held", () => {
    const run = more(reviewing(), [
      pass(),
      stopped(5, "nothing"),
      you({ kind: "set", intent: "try" }),
      plugin({ kind: "output_failed", request: 6, error: "down" }),
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.hold?.kind).toBe("failed");
  });

  test("a change of rigor lets the tester carry on", () => {
    const run = more(reviewing(), [you({ kind: "set", rigor: "light" })]);
    expect(types(run.events)).toEqual(["task.set"]);
    const state = taskOf(run).state;
    expect(state.phase === "review" && [state.rigor, state.step.kind]).toEqual([
      "light",
      "running",
    ]);
  });
});

describe("a change of approval", () => {
  const awaiting = () =>
    more(reviewing(), [you({ kind: "set", approve: true }), pass(), stopped(5, "nothing")]);

  test("setting it before the output is ready makes the task wait for you", () => {
    const state = taskOf(awaiting()).state;
    expect(state.phase === "review" && state.step.kind).toBe("awaiting_approval");
  });

  test("clearing it on a task waiting for you delivers it", () => {
    const run = more(awaiting(), [you({ kind: "set", approve: false })]);
    expect(types(run.events)).toEqual(["task.set", "output.ready", "output.requested"]);
    expect(run.commands.map((c) => c.kind)).toEqual(["deliver_output"]);
  });

  test("clearing it doesn't skip sign-off for a critical file", () => {
    const run = more(building(), [
      you({ kind: "set", approve: true }),
      agent({ session: 2, role: "builder", kind: "done", commit: "c1", files: [], work: summary }),
      stopped(2),
      plugin({ kind: "main_merged", request: 3, commit: "m3", files: ["src/auth/token.ts"] }),
      plugin({ kind: "workspace_created", request: 4, path: "/w/copy" }),
      plugin({ kind: "session_started", request: 5, harnessId: "h5" }),
      pass(),
      stopped(5, "nothing"),
      you({ kind: "set", approve: false }),
    ]);
    expect(types(run.events).slice(-1)).toEqual(["task.set"]);
    const state = taskOf(run).state;
    expect(state.phase === "review" && state.step.kind).toBe("awaiting_approval");
  });

  test("setting it on a held task with its output ready makes it wait for you", () => {
    const run = more(reviewing(), [
      pass(),
      you({ kind: "pause" }),
      stopped(5, "nothing"),
      you({ kind: "set", approve: true }),
    ]);
    expect(types(run.events).slice(-2)).toEqual(["task.set", "approval.requested"]);
  });
});

describe("found by the property tests", () => {
  test("approval set during a delivery that then fails is asked for before the retry delivers", () => {
    const failed = more(reviewing(), [
      pass(),
      stopped(5, "nothing"),
      you({ kind: "set", approve: true }),
      plugin({ kind: "output_failed", request: 6, error: "down" }),
    ]);
    const run = more(failed, [you({ kind: "retry" })]);
    expect(run.commands.filter((c) => c.kind === "deliver_output")).toEqual([]);
    expect(types(run.events)).toEqual(["task.resumed", "approval.requested"]);
  });

  test("an approval given before a failed delivery still counts on the retry", () => {
    const failed = more(reviewing(), [
      you({ kind: "set", approve: true }),
      pass(),
      stopped(5, "nothing"),
      you({ kind: "approve" }),
      plugin({ kind: "output_failed", request: 6, error: "down" }),
    ]);
    const run = more(failed, [you({ kind: "retry" })]);
    expect(run.commands.map((c) => c.kind)).toEqual(["deliver_output"]);
  });
});

describe("found in review of set", () => {
  test("a tester isn't started on stale work after a failed start and a retry", () => {
    const failed = more(merging(), [
      plugin({ kind: "main_merged", request: 3, commit: "m3", files: ["src/x.ts"] }),
      plugin({ kind: "workspace_created", request: 4, path: "/w/copy" }),
      you({ kind: "set", intent: "answer" }),
      plugin({ kind: "session_failed", request: 5, error: "no tmux" }),
    ]);
    const run = more(failed, [you({ kind: "retry" }), daemon({ kind: "start" })]);
    expect(startsOf(run)).toEqual([
      expect.objectContaining({ role: "builder", intent: "answer", edits: false }),
    ]);
    expect(phaseOf(run)).toBe("build");
  });

  test("your light rigor drops the planner's spec, since a light task gets none", () => {
    const run = more(triage(), [
      you({ kind: "set", rigor: "light" }),
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
      agent({
        session: 2,
        role: "planner",
        kind: "proceed",
        intent: "ship",
        rigor: "full",
        approve: false,
        brief: "b",
        spec: { path: "docs/plans/x.md", text: "# Plan" },
      }),
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "stop_session",
      task: "t1",
      session: 2,
      save: false,
    });
    const done = more(run, [stopped(2, "nothing")]);
    const state = taskOf(done).state;
    expect(state.phase === "build" && [state.rigor, state.spec]).toEqual(["light", undefined]);
  });
});
