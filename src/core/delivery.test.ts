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
import type { Intent, Output, Work } from "./types";

type Setup = { intent?: Intent; approve?: boolean; files?: string[] };

const workFor = (intent: Intent): Work =>
  intent === "answer"
    ? {
        kind: "report",
        text: "Search is slow because of N+1 queries",
        proposals: [{ title: "Batch the queries", description: "One query per page" }],
      }
    : { kind: "summary", text: "Headers on empty reports" };

// Through build, up to the builder's stop. Requests: workspace 1,
// builder 2, then merge 3 for ship and try.
const handedOver = ({ intent = "ship", approve = false, files = ["src/export.ts"] }: Setup = {}) =>
  play([
    you({ kind: "add", title: "Fix export", description: "", intent, rigor: "full", approve }),
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
    agent({
      session: 2,
      role: "builder",
      kind: "done",
      commit: "c1",
      files,
      work: workFor(intent),
    }),
    plugin({ kind: "session_stopped", session: 2, save: "saved" }),
  ]);

// Through review to the pass and the tester's stop.
const passed = (setup: Setup = {}): Played => {
  const intent = setup.intent ?? "ship";
  let run = handedOver(setup);
  if (intent === "ship") {
    run = more(run, [
      plugin({
        kind: "main_merged",
        request: 3,
        commit: "m3",
        files: setup.files ?? ["src/export.ts"],
      }),
    ]);
  }
  const copy = taskOf(run).requests;
  return more(run, [
    plugin({ kind: "workspace_created", request: copy, path: "/w/copy" }),
    plugin({ kind: "session_started", request: copy + 1, harnessId: "h" }),
    agent({ session: copy + 1, role: "tester", kind: "pass", evidence: "All green" }),
    plugin({ kind: "session_stopped", session: copy + 1, save: "nothing" }),
  ]);
};

const shipOutput: Output = {
  kind: "branch",
  branch: "skel/t1-fix-export",
  commit: "m3",
  mergeable: true,
  summary: "Headers on empty reports",
  evidence: "All green",
};

describe("after a pass", () => {
  test("a ship task with nothing to sign off is delivered at once", () => {
    const run = passed();
    expect(types(run.events).slice(-3)).toEqual([
      "workspace.removed",
      "output.ready",
      "output.requested",
    ]);
    expect(run.commands.at(-1)).toEqual({
      kind: "deliver_output",
      task: "t1",
      request: 6,
      output: shipOutput,
    });
    const state = taskOf(run).state;
    expect(state.phase === "review" && state.step).toEqual({
      kind: "delivering",
      request: 6,
      output: shipOutput,
      critical: false,
    });
  });

  test("once delivery is confirmed, the task is done and its worktree goes, keeping the branch", () => {
    const run = more(passed(), [plugin({ kind: "output_delivered", request: 6 })]);
    expect(types(run.events)).toEqual(["output.delivered", "workspace.removed"]);
    expect(run.commands).toEqual([{ kind: "remove_workspace", task: "t1", path: "/w/t1" }]);
    expect(taskOf(run).state).toEqual({
      phase: "ended",
      outcome: { kind: "done", output: shipOutput },
      proposals: [],
    });
  });

  test("a failed delivery holds the task, with the output ready again", () => {
    const run = more(passed(), [
      plugin({ kind: "output_failed", request: 6, error: "GitHub is down" }),
    ]);
    expect(types(run.events)).toEqual(["output.failed", "task.held"]);
    const state = taskOf(run).state;
    expect(state.phase === "review" && state.step).toEqual({
      kind: "ready",
      output: shipOutput,
      critical: false,
    });
    expect(state.phase === "review" && state.hold).toEqual({
      kind: "failed",
      what: "delivery",
      error: "GitHub is down",
    });
  });
});

describe("sign-off", () => {
  test("the approval flag makes the task wait for you", () => {
    const run = passed({ approve: true });
    expect(types(run.events).slice(-2)).toEqual(["output.ready", "approval.requested"]);
    expect(run.commands.filter((c) => c.kind === "deliver_output")).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "review" && state.step.kind).toBe("awaiting_approval");
  });

  test("a change to a critical path needs sign-off without the flag", () => {
    const run = passed({ files: ["src/export.ts", "src/auth/token.ts"] });
    const state = taskOf(run).state;
    expect(state.phase === "review" && state.step).toMatchObject({
      kind: "awaiting_approval",
      critical: true,
    });
  });

  test("your approval delivers it", () => {
    const run = more(passed({ approve: true }), [you({ kind: "approve" })]);
    expect(types(run.events)).toEqual(["approval.given", "output.requested"]);
    expect(run.commands).toEqual([
      { kind: "deliver_output", task: "t1", request: 6, output: shipOutput },
    ]);
  });

  test("a denial sends the task back to build with your note, without counting a loop", () => {
    const run = more(passed({ approve: true }), [
      you({ kind: "deny", note: "Use the shared writer" }),
    ]);
    expect(types(run.events)).toEqual(["approval.denied", "phase.started"]);
    expect(run.commands).toEqual([]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && [state.step, state.handback, state.loops]).toEqual([
      { kind: "queued" },
      { kind: "denied", note: "Use the shared writer" },
      0,
    ]);
  });

  test("a denial with no note is refused", () => {
    const run = more(passed({ approve: true }), [you({ kind: "deny", note: "" })]);
    expect(refused(run.last)).toBe("a denial needs a note for the builder");
  });

  test("approving a task that isn't waiting for it is refused", () => {
    const run = more(handedOver(), [you({ kind: "approve" })]);
    expect(refused(run.last)).toBe("task t1 isn't waiting for your approval");
  });

  test("approving twice is refused the second time", () => {
    const run = more(passed({ approve: true }), [
      you({ kind: "approve" }),
      you({ kind: "approve" }),
    ]);
    expect(refused(run.last)).toBe("task t1 isn't waiting for your approval");
  });

  test("an agent can't approve, since no agent input does", () => {
    const run = more(passed({ approve: true }), [
      agent({ session: 5, role: "tester", kind: "pass", evidence: "again" }),
    ]);
    expect(refused(run.last)).toBe("session 5 isn't the task's agent");
  });
});

describe("try and answer", () => {
  test("try skips review and is delivered as not mergeable, with no evidence", () => {
    const run = more(handedOver({ intent: "try" }), [
      plugin({ kind: "main_merged", request: 3, commit: "m3", files: ["src/export.ts"] }),
    ]);
    expect(types(run.events)).toEqual(["main.merged", "output.ready", "output.requested"]);
    expect(run.commands).toEqual([
      {
        kind: "deliver_output",
        task: "t1",
        request: 4,
        output: {
          kind: "branch",
          branch: "skel/t1-fix-export",
          commit: "m3",
          mergeable: false,
          summary: "Headers on empty reports",
        },
      },
    ]);
  });

  test("a try that touches a critical path waits for you after build", () => {
    const run = more(handedOver({ intent: "try", files: ["src/auth/x.ts"] }), [
      plugin({ kind: "main_merged", request: 3, commit: "m3", files: ["src/auth/x.ts"] }),
    ]);
    const state = taskOf(run).state;
    expect(state.phase === "build" && state.step.kind).toBe("awaiting_approval");
  });

  test("an answer delivers its report at the handed-over commit, and its proposals wait", () => {
    let run = passed({ intent: "answer" });
    const delivery = run.commands.at(-1);
    expect(delivery).toEqual({
      kind: "deliver_output",
      task: "t1",
      request: 5,
      output: {
        kind: "report",
        commit: "c1",
        report: "Search is slow because of N+1 queries",
        evidence: "All green",
      },
    });
    run = more(run, [plugin({ kind: "output_delivered", request: 5 })]);
    const state = taskOf(run).state;
    expect(state.phase === "ended" && state.proposals).toEqual([
      { title: "Batch the queries", description: "One query per page", decision: "pending" },
    ]);
  });
});
