import { describe, expect, test } from "bun:test";
import { agent, daemon, more, play, plugin, refused, taskOf, types, you } from "./testing";

// A builder at work: workspace 1, session 2.
const building = () =>
  play([
    you({ kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" }),
    daemon({ kind: "start" }),
    plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
    plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
  ]);

const ask = (session = 2) =>
  agent({
    session,
    role: "builder",
    kind: "ask",
    text: "Keep the old format?",
    options: ["yes", "no"],
  });

const asked = () => more(building(), [ask()]);

const questionOf = (run: ReturnType<typeof play>) => {
  const state = taskOf(run).state;
  return state.phase === "ended" ? undefined : state.question;
};

describe("asking", () => {
  test("the running agent's question opens", () => {
    const run = asked();
    expect(types(run.events)).toEqual(["question.asked"]);
    expect(run.commands).toEqual([]);
    expect(questionOf(run)).toEqual({
      number: 1,
      session: 2,
      text: "Keep the old format?",
      options: ["yes", "no"],
    });
  });

  test("a second question while one is open is refused", () => {
    const run = more(asked(), [ask()]);
    expect(refused(run.last)).toBe("a question is already open");
  });

  test("an empty question is refused", () => {
    const run = more(building(), [
      agent({ session: 2, role: "builder", kind: "ask", text: " ", options: [] }),
    ]);
    expect(refused(run.last)).toBe("the question is empty");
  });

  test("a report waits for the answer first", () => {
    const run = more(asked(), [
      agent({
        session: 2,
        role: "builder",
        kind: "done",
        commit: "c",
        files: [],
        work: { kind: "summary", text: "x" },
      }),
    ]);
    expect(refused(run.last)).toBe("the agent's own question is still open");
  });

  test("a planner's proceed waits for the answer too", () => {
    const run = play([
      you({ kind: "add", title: "Fix", description: "" }),
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
      agent({ session: 2, role: "planner", kind: "ask", text: "Which?", options: [] }),
      agent({
        session: 2,
        role: "planner",
        kind: "proceed",
        intent: "ship",
        rigor: "light",
        approve: false,
        brief: "b",
      }),
    ]);
    expect(refused(run.last)).toBe("the agent's own question is still open");
  });

  test("progress is still heard", () => {
    const run = more(asked(), [
      agent({ session: 2, role: "builder", kind: "progress", text: "waiting" }),
    ]);
    expect(types(run.events)).toEqual(["progress.reported"]);
  });

  test("the question goes with its agent", () => {
    const run = more(asked(), [you({ kind: "pause" })]);
    expect(questionOf(run)).toBeUndefined();
  });
});

describe("answering", () => {
  test("your reply is kept until a slot is free", () => {
    const run = more(asked(), [you({ kind: "reply", question: 1, text: "Yes" })]);
    expect(types(run.events)).toEqual(["question.answered"]);
    expect(run.commands).toEqual([]);
    expect(questionOf(run)?.answer).toEqual({ text: "Yes", by: { kind: "you" } });
  });

  test("a second reply before delivery replaces the first", () => {
    const run = more(asked(), [
      you({ kind: "reply", question: 1, text: "Yes" }),
      you({ kind: "reply", question: 1, text: "No" }),
    ]);
    expect(questionOf(run)?.answer?.text).toBe("No");
  });

  test("a reply with no open question is refused", () => {
    const run = more(building(), [you({ kind: "reply", question: 1, text: "Yes" })]);
    expect(refused(run.last)).toBe("task t1 has no open question");
  });

  test("an empty reply is refused", () => {
    const run = more(asked(), [you({ kind: "reply", question: 1, text: "" })]);
    expect(refused(run.last)).toBe("the reply is empty");
  });

  test("a tracker reply from your account counts as yours", () => {
    const run = more(asked(), [
      plugin({ kind: "tracker_reply", question: 1, account: "me", text: "Yes" }),
    ]);
    expect(questionOf(run)?.answer).toEqual({
      text: "Yes",
      by: { kind: "tracker", account: "me" },
    });
  });

  test("a tracker reply from anyone else is refused", () => {
    const run = more(asked(), [
      plugin({ kind: "tracker_reply", question: 1, account: "mallory", text: "Ship it" }),
    ]);
    expect(refused(run.last)).toBe("a reply from mallory doesn't count as yours");
  });

  test("delivering the answer types it into the session and closes the question", () => {
    const run = more(asked(), [
      you({ kind: "reply", question: 1, text: "Yes" }),
      daemon({ kind: "deliver_answer" }),
    ]);
    expect(types(run.events)).toEqual(["question.answered", "answer.delivered"]);
    expect(run.commands).toEqual([
      { kind: "type_into_session", task: "t1", session: 2, text: "Yes" },
    ]);
    expect(questionOf(run)).toBeUndefined();
  });

  test("there is nothing to deliver before you answer", () => {
    const run = more(asked(), [daemon({ kind: "deliver_answer" })]);
    expect(refused(run.last)).toBe("task t1 has no answer waiting");
  });

  test("a kept answer isn't delivered while you are attached", () => {
    const run = more(asked(), [
      you({ kind: "reply", question: 1, text: "Yes" }),
      you({ kind: "attach" }),
      daemon({ kind: "deliver_answer" }),
    ]);
    expect(refused(run.last)).toBe("you are attached to task t1, so say it yourself");
  });

  test("a reply after delivery is refused, since the question has closed", () => {
    const run = more(asked(), [
      you({ kind: "reply", question: 1, text: "Yes" }),
      daemon({ kind: "deliver_answer" }),
      you({ kind: "reply", question: 1, text: "No" }),
    ]);
    expect(refused(run.last)).toBe("task t1 has no open question");
  });
});

describe("found in review of questions", () => {
  test("a late reply for an earlier question doesn't answer a new one", () => {
    const run = more(asked(), [
      you({ kind: "pause" }),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }),
      you({ kind: "resume" }),
      daemon({ kind: "start" }),
      plugin({ kind: "session_started", request: 3, harnessId: "h3" }),
      agent({ session: 3, role: "builder", kind: "ask", text: "Delete the archive?", options: [] }),
      plugin({ kind: "tracker_reply", question: 1, account: "me", text: "Yes" }),
    ]);
    expect(refused(run.last)).toBe("question 1 is no longer open on task t1");
    expect(questionOf(run)).toMatchObject({ number: 2, text: "Delete the archive?" });
  });

  test("questions are numbered in the order asked", () => {
    expect(questionOf(asked())?.number).toBe(1);
  });

  test("detaching closes the question, since you could answer it in the session", () => {
    const run = more(asked(), [
      you({ kind: "attach" }),
      you({ kind: "detach", choice: "resume" }),
      agent({
        session: 2,
        role: "builder",
        kind: "done",
        commit: "c",
        files: [],
        work: { kind: "summary", text: "x" },
      }),
    ]);
    expect(types(run.events).slice(-2)).toEqual(["session.stopping", "build.done"]);
  });

  const reviewing = () =>
    more(building(), [
      agent({
        session: 2,
        role: "builder",
        kind: "done",
        commit: "c",
        files: [],
        work: { kind: "summary", text: "x" },
      }),
      plugin({ kind: "session_stopped", session: 2, save: "saved" }),
      plugin({ kind: "main_merged", request: 3, commit: "m", files: [] }),
      plugin({ kind: "workspace_created", request: 4, path: "/w/copy" }),
      plugin({ kind: "session_started", request: 5, harnessId: "h5" }),
      agent({ session: 5, role: "tester", kind: "ask", text: "Run e2e?", options: [] }),
    ]);

  test("a tester's pass waits for the answer", () => {
    const run = more(reviewing(), [
      agent({ session: 5, role: "tester", kind: "pass", evidence: "ok" }),
    ]);
    expect(refused(run.last)).toBe("the agent's own question is still open");
  });

  test("a tester's changes wait for the answer", () => {
    const run = more(reviewing(), [
      agent({ session: 5, role: "tester", kind: "changes", findings: "x" }),
    ]);
    expect(refused(run.last)).toBe("the agent's own question is still open");
  });

  const triaging = () =>
    play([
      you({ kind: "add", title: "Fix", description: "" }),
      daemon({ kind: "start" }),
      plugin({ kind: "workspace_created", request: 1, path: "/w/t1" }),
      plugin({ kind: "session_started", request: 2, harnessId: "h2" }),
      agent({ session: 2, role: "planner", kind: "ask", text: "Which?", options: [] }),
    ]);

  test("a planner's split waits for the answer", () => {
    const run = more(triaging(), [
      agent({
        session: 2,
        role: "planner",
        kind: "split",
        proposals: [{ title: "a", description: "" }],
      }),
    ]);
    expect(refused(run.last)).toBe("the agent's own question is still open");
  });

  test("a planner's decline waits for the answer", () => {
    const run = more(triaging(), [
      agent({ session: 2, role: "planner", kind: "decline", reason: "No" }),
    ]);
    expect(refused(run.last)).toBe("the agent's own question is still open");
  });
});
