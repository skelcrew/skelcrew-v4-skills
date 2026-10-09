// Helpers for the core's tests. They play inputs through `decide` and
// `evolve`, as the loop will, and keep what came out.

import { decide } from "./decide";
import { evolve } from "./evolve";
import type {
  AgentInput,
  Command,
  Config,
  DaemonInput,
  Decision,
  Event,
  Input,
  PluginInput,
  Task,
  YouInput,
} from "./types";

export const config: Config = { maxRunning: 2, critical: ["src/auth/**"], accounts: ["me"] };

export type Played = {
  tasks: Map<string, Task>;
  events: Event[];
  commands: Command[];
  last: Decision;
};

// Plays each input in order. A refused input changes nothing, as in the
// loop. An event `evolve` refuses is a bug in the core, so it throws here.
export function play(inputs: Input[], cfg: Config = config, from?: Played): Played {
  const tasks = new Map(from?.tasks ?? []);
  const events: Event[] = [];
  const commands: Command[] = [];
  let last: Decision = { ok: false, reason: "nothing played" };
  for (const input of inputs) {
    last = decide(tasks.get(input.task), input, cfg);
    if (!last.ok) continue;
    for (const event of last.events) {
      const next = evolve(tasks.get(event.task), event);
      if (!next.ok) throw new Error(`evolve refused ${event.type}: ${next.reason}`);
      tasks.set(event.task, next.task);
    }
    events.push(...last.events);
    commands.push(...last.commands);
  }
  return { tasks, events, commands, last };
}

// Plays more inputs after an earlier run. Only the new events and commands
// are returned.
export function more(from: Played, inputs: Input[], cfg: Config = config): Played {
  return play(inputs, cfg, from);
}

export function taskOf(played: Played, id = "t1"): Task {
  const task = played.tasks.get(id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
}

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let clock = 1_000;
const tick = () => {
  clock += 1_000;
  return clock;
};

export function you(body: Without<YouInput, "sender" | "task" | "at">, task = "t1"): YouInput {
  return { ...body, sender: "you", task, at: tick() };
}

export function agent(
  body: Without<AgentInput, "sender" | "task" | "at">,
  task = "t1",
): AgentInput {
  return { ...body, sender: "agent", task, at: tick() };
}

export function plugin(
  body: Without<PluginInput, "sender" | "task" | "at">,
  task = "t1",
): PluginInput {
  return { ...body, sender: "plugin", task, at: tick() };
}

export function daemon(
  body: Without<DaemonInput, "sender" | "task" | "at">,
  task = "t1",
): DaemonInput {
  return { ...body, sender: "daemon", task, at: tick() };
}

export function refused(decision: Decision): string {
  if (decision.ok) throw new Error("expected the input to be refused, but it was accepted");
  return decision.reason;
}

export function types(events: Event[]): string[] {
  return events.map((event) => event.type);
}
