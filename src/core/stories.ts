// Whole lifecycles, as lists of inputs. `stories.test.ts` saves every
// event and command they produce as snapshots, so any change to what the
// log records shows up in review. The stories are the ones in
// `docs/core.md`, part 1, plus two that later parts added.

import { decide } from "./decide";
import { evolve } from "./evolve";
import type { AgentInput, Config, DaemonInput, Input, PluginInput, Task, YouInput } from "./types";

export const config: Config = { maxRunning: 2, critical: ["src/auth/**"], accounts: ["me"] };

type Body<T> = T extends unknown ? Omit<T, "sender" | "task" | "at"> : never;
export type Line =
  | { you: Body<YouInput> }
  | { agent: Body<AgentInput> }
  | { plugin: Body<PluginInput> }
  | { daemon: Body<DaemonInput> };

// Plays a story on task t1, one input a second, and returns what each input
// gave: its events and commands, or why it was refused.
export function tell(lines: Line[]) {
  let task: Task | undefined;
  return lines.map((line, index) => {
    const at = (index + 1) * 1_000;
    const stamp = { task: "t1", at };
    const input: Input =
      "you" in line
        ? { ...line.you, sender: "you", ...stamp }
        : "agent" in line
          ? { ...line.agent, sender: "agent", ...stamp }
          : "plugin" in line
            ? { ...line.plugin, sender: "plugin", ...stamp }
            : { ...line.daemon, sender: "daemon", ...stamp };
    const decision = decide(task, input, config);
    if (!decision.ok) return { input: input.kind, refused: decision.reason };
    for (const event of decision.events) {
      const next = evolve(task, event);
      if (!next.ok) throw new Error(next.reason);
      task = next.task;
    }
    return { input: input.kind, events: decision.events, commands: decision.commands };
  });
}

const summary = { kind: "summary", text: "Headers on empty reports" } satisfies {
  kind: "summary";
  text: string;
};
const done = (session: number, files = ["src/export.ts"]): Line => ({
  agent: { session, role: "builder", kind: "done", commit: `c${session}`, files, work: summary },
});
const stopped = (session: number, save: "saved" | "nothing" | "failed" = "saved"): Line => ({
  plugin: { kind: "session_stopped", session, save },
});
const started = (request: number): Line => ({
  plugin: { kind: "session_started", request, harnessId: `h${request}` },
});
const created = (request: number, path: string): Line => ({
  plugin: { kind: "workspace_created", request, path },
});
const merged = (request: number, files = ["src/export.ts"]): Line => ({
  plugin: { kind: "main_merged", request, commit: `m${request}`, files },
});
const pass = (session: number): Line => ({
  agent: { session, role: "tester", kind: "pass", evidence: "All tests pass" },
});
const changes = (session: number): Line => ({
  agent: { session, role: "tester", kind: "changes", findings: "No test for empty reports" },
});
const start: Line = { daemon: { kind: "start" } };

export const stories: { name: string; lines: Line[] }[] = [
  {
    name: "1. a quick fix: triage skipped, built, merged, reviewed and delivered",
    lines: [
      {
        you: {
          kind: "add",
          title: "Fix button color",
          description: "",
          intent: "ship",
          rigor: "light",
        },
      },
      start,
      created(1, "/w/t1"),
      started(2),
      done(2),
      stopped(2),
      merged(3),
      created(4, "/w/t1-copy"),
      started(5),
      pass(5),
      stopped(5, "nothing"),
      { plugin: { kind: "output_delivered", request: 6 } },
    ],
  },
  {
    name: "2. a full feature with sign-off: one round of changes, then approval",
    lines: [
      { you: { kind: "add", title: "Refresh auth tokens", description: "Before they expire" } },
      start,
      created(1, "/w/t1"),
      started(2),
      {
        agent: {
          session: 2,
          role: "planner",
          kind: "proceed",
          intent: "ship",
          rigor: "full",
          approve: true,
          brief: "Refresh tokens a minute early.",
          spec: { path: "docs/plans/t1-refresh-auth-tokens.md", text: "# Plan" },
        },
      },
      stopped(2),
      started(3),
      done(3, ["src/auth/token.ts"]),
      stopped(3),
      merged(4, ["src/auth/token.ts"]),
      created(5, "/w/t1-copy"),
      started(6),
      changes(6),
      stopped(6, "nothing"),
      started(7),
      done(7, ["src/auth/token.ts"]),
      stopped(7),
      merged(8, ["src/auth/token.ts"]),
      created(9, "/w/t1-copy2"),
      started(10),
      pass(10),
      stopped(10, "nothing"),
      { you: { kind: "approve" } },
      { plugin: { kind: "output_delivered", request: 11 } },
    ],
  },
  {
    name: "3. a crash and a retry: held with the exit code, then a fresh builder told why",
    lines: [
      { you: { kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" } },
      start,
      created(1, "/w/t1"),
      started(2),
      { plugin: { kind: "session_ended", session: 2, exitCode: 137, lastLine: "Killed" } },
      stopped(2),
      start,
      { you: { kind: "retry" } },
      start,
      started(3),
    ],
  },
  {
    name: "4. a question: the slot frees, your answer waits, then reaches the builder",
    lines: [
      { you: { kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" } },
      start,
      created(1, "/w/t1"),
      started(2),
      {
        agent: {
          session: 2,
          role: "builder",
          kind: "ask",
          text: "Keep CSV?",
          options: ["yes", "no"],
        },
      },
      { you: { kind: "reply", question: 1, text: "yes" } },
      { daemon: { kind: "deliver_answer" } },
      done(2),
    ],
  },
  {
    name: "5. a split: the task ends, its workspace and branch go, one proposal is approved",
    lines: [
      { you: { kind: "add", title: "Rework export", description: "" } },
      start,
      created(1, "/w/t1"),
      started(2),
      {
        agent: {
          session: 2,
          role: "planner",
          kind: "split",
          proposals: [
            { title: "Export headers", description: "Empty reports" },
            { title: "Export footers", description: "Totals" },
          ],
        },
      },
      stopped(2, "nothing"),
      { you: { kind: "approve_proposals", which: [0] } },
      { you: { kind: "deny_proposals", which: [1] } },
      { you: { kind: "pause" } },
    ],
  },
  {
    name: "6. a prototype: try skips review and is delivered as not mergeable",
    lines: [
      {
        you: {
          kind: "add",
          title: "Try offline sync",
          description: "",
          intent: "try",
          rigor: "light",
        },
      },
      start,
      created(1, "/w/t1"),
      started(2),
      done(2),
      stopped(2),
      merged(3),
      { plugin: { kind: "output_delivered", request: 4 } },
    ],
  },
  {
    name: "7. a conflict: a loop is counted and a fresh builder gets the merge back",
    lines: [
      { you: { kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" } },
      start,
      created(1, "/w/t1"),
      started(2),
      done(2),
      stopped(2),
      { plugin: { kind: "main_conflict", request: 3 } },
      started(4),
    ],
  },
  {
    name: "8. the loop cap: three rounds of changes hold the task, and kill fails it",
    lines: (() => {
      const round = (builder: number): Line[] => [
        done(builder),
        stopped(builder),
        merged(builder + 1),
        created(builder + 2, `/w/copy${builder}`),
        started(builder + 3),
        changes(builder + 3),
        stopped(builder + 3, "nothing"),
      ];
      return [
        {
          you: { kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" },
        },
        start,
        created(1, "/w/t1"),
        started(2),
        ...round(2),
        started(6),
        ...round(6),
        started(10),
        ...round(10),
        { you: { kind: "kill" } },
      ];
    })(),
  },
  {
    name: "9. a pause during a start: the new session is stopped once it starts",
    lines: [
      { you: { kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" } },
      start,
      created(1, "/w/t1"),
      { you: { kind: "pause" } },
      started(2),
      stopped(2, "nothing"),
      start,
      { you: { kind: "resume" } },
      start,
    ],
  },
  {
    name: "10. you attach and hand over: the task merges main and goes to review",
    lines: [
      { you: { kind: "add", title: "Fix export", description: "", intent: "ship", rigor: "full" } },
      start,
      created(1, "/w/t1"),
      started(2),
      { you: { kind: "attach" } },
      { you: { kind: "detach", choice: "hand_over", commit: "c-you", files: ["src/export.ts"] } },
      stopped(2),
      merged(3),
    ],
  },
  {
    name: "11. a change of intent: the builder stops, saving, and a read-only one starts",
    lines: [
      {
        you: {
          kind: "add",
          title: "Why is search slow",
          description: "",
          intent: "ship",
          rigor: "full",
        },
      },
      start,
      created(1, "/w/t1"),
      started(2),
      { you: { kind: "set", intent: "answer" } },
      stopped(2),
    ],
  },
];
