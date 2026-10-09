// Every input that could plausibly arrive next, for the property tests.
// It covers each sender, with good and bad versions: replies old and new,
// agents in and out of their role, and your calls in any state.

import type { AgentInput, DaemonInput, Input, Role, TaskId, YouInput } from "./types";
import type { World } from "./world";

type Body<T> = T extends unknown ? Omit<T, "sender" | "task" | "at"> : never;

export const taskIds: TaskId[] = ["t1", "t2", "t3"];

const proposals = [
  { title: "Part one", description: "The first half" },
  { title: "Part two", description: "The second half" },
];

function you(task: TaskId): Body<YouInput>[] {
  return [
    { kind: "add", title: `Task ${task}`, description: "Do it" },
    { kind: "add", title: `Task ${task}`, description: "Do it", intent: "ship", rigor: "light" },
    { kind: "add", title: `Task ${task}`, description: "Do it", intent: "try", rigor: "full" },
    { kind: "add", title: `Task ${task}`, description: "", intent: "answer", rigor: "full" },
    { kind: "add", title: `Task ${task}`, description: "", approve: true },
    { kind: "add", title: `Task ${task}`, description: "", intent: "answer" },
    { kind: "add", title: `Task ${task}`, description: "", rigor: "light" },
    { kind: "set", intent: "answer" },
    { kind: "set", intent: "ship", rigor: "full" },
    { kind: "set", approve: true },
    { kind: "set", approve: false },
    { kind: "reply", text: "Yes" },
    { kind: "approve" },
    { kind: "deny", note: "Not like this" },
    { kind: "approve_proposals", which: [0] },
    { kind: "deny_proposals", which: [1] },
    { kind: "attach" },
    { kind: "detach", choice: "resume" },
    { kind: "detach", choice: "hand_over", commit: "c-you", files: ["src/export.ts"] },
    { kind: "pause" },
    { kind: "resume" },
    { kind: "start" },
    { kind: "retry" },
    { kind: "kill" },
  ];
}

function agentInputs(session: number, role: Role): Body<AgentInput>[] {
  const from = { session, role };
  const done = (commit: string, files: string[]): Body<AgentInput>[] => [
    { ...from, kind: "done", commit, files, work: { kind: "summary", text: "Done" } },
    {
      ...from,
      kind: "done",
      commit,
      files,
      work: { kind: "report", text: "Found it", proposals },
    },
  ];
  return [
    { ...from, kind: "proceed", intent: "ship", rigor: "full", approve: false, brief: "Brief" },
    {
      ...from,
      kind: "proceed",
      intent: "ship",
      rigor: "full",
      approve: true,
      brief: "Brief",
      spec: { path: "docs/plans/x.md", text: "# Plan" },
    },
    { ...from, kind: "proceed", intent: "try", rigor: "light", approve: false, brief: "Brief" },
    { ...from, kind: "proceed", intent: "answer", rigor: "light", approve: false, brief: "Brief" },
    { ...from, kind: "split", proposals },
    { ...from, kind: "decline", reason: "Not needed" },
    { ...from, kind: "ask", text: "Which?", options: ["a", "b"] },
    { ...from, kind: "give_up", reason: "Stuck" },
    { ...from, kind: "progress", text: "Halfway" },
    ...done(`c${session}`, ["src/export.ts"]),
    ...done(`c${session}`, ["src/auth/login.ts"]),
    { ...from, kind: "pass", evidence: "Tests pass" },
    { ...from, kind: "changes", findings: "Missing a test" },
  ];
}

function daemon(): Body<DaemonInput>[] {
  return [
    { kind: "start" },
    { kind: "deliver_answer" },
    {
      kind: "usage",
      session: 2,
      usage: { input: 10, output: 5, cacheWrite: 1, cacheRead: 100, minutes: 1 },
    },
  ];
}

// Every candidate input for the world as it is now.
export function candidates(world: World): Input[] {
  const inputs: Input[] = [];
  const stamp = { at: world.now() };
  for (const task of taskIds) {
    for (const body of you(task)) inputs.push({ ...body, sender: "you", task, ...stamp });
    for (const body of daemon()) inputs.push({ ...body, sender: "daemon", task, ...stamp });
    inputs.push({
      sender: "plugin",
      task,
      ...stamp,
      kind: "task_arrived",
      source: { kind: "github", id: task },
      title: `Issue ${task}`,
      description: "From the tracker",
    });
    inputs.push({ sender: "plugin", task, ...stamp, kind: "outside_change", change: "closed" });
    for (const account of ["me", "stranger"]) {
      inputs.push({ sender: "plugin", task, ...stamp, kind: "tracker_reply", account, text: "Ok" });
    }
    // Agents: the last two sessions the task asked for, in every role, so
    // an old session and wrong roles come up too.
    const sessions = world.sent
      .filter((command) => command.kind === "start_session" && command.task === task)
      .slice(-2);
    for (const command of sessions) {
      if (command.kind !== "start_session") continue;
      for (const role of ["planner", "builder", "tester"] satisfies Role[]) {
        for (const body of agentInputs(command.request, role)) {
          inputs.push({ ...body, sender: "agent", task, ...stamp });
        }
      }
    }
  }
  for (const reply of world.replies) {
    if (!world.fits(reply.task, reply.body)) continue;
    inputs.push({ ...reply.body, sender: "plugin", task: reply.task, ...stamp });
  }
  return inputs;
}

// Inputs that move a task backwards or end it. Guided picks leave them out,
// or they would crowd out progress.
export function isBackward(input: Input): boolean {
  if (input.sender === "you") {
    return ["pause", "kill", "set", "deny", "detach", "attach"].includes(input.kind);
  }
  if (input.sender === "agent") return ["give_up", "decline", "split"].includes(input.kind);
  if (input.sender === "plugin") {
    return [
      "workspace_failed",
      "session_failed",
      "session_ended",
      "main_failed",
      "output_failed",
    ].includes(input.kind);
  }
  return false;
}
