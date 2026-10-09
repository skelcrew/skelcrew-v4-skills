// The events and commands of one decision. Each event is applied as it is
// recorded, so the next step of the decision reads the task as it now is.

import { evolve } from "./evolve";
import type { Command, Decision, Event, Input, Task } from "./types";

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventBody = Without<Event, "v" | "task" | "at">;

export class Draft {
  readonly events: Event[] = [];
  readonly commands: Command[] = [];
  private broken: string | undefined;

  constructor(
    public task: Task,
    private readonly input: Input,
    first: Event[] = [],
  ) {
    this.events.push(...first);
  }

  record(body: EventBody): void {
    if (this.broken !== undefined) return;
    const event: Event = stamp(body, this.input);
    const next = evolve(this.task, event);
    if (!next.ok) {
      this.broken = next.reason;
      return;
    }
    this.task = next.task;
    this.events.push(event);
  }

  send(command: Command): void {
    this.commands.push(command);
  }

  // The number the next request takes.
  nextRequest(): number {
    return this.task.requests + 1;
  }

  done(): Decision {
    if (this.broken !== undefined) return refuse(`the core made a mistake: ${this.broken}`);
    return { ok: true, events: this.events, commands: this.commands };
  }
}

export function stamp(body: EventBody, input: Input): Event {
  return { ...body, v: 1, task: input.task, at: input.at };
}

export function accept(commands: Command[]): Decision {
  return { ok: true, events: [], commands };
}

export function refuse(reason: string): Decision {
  return { ok: false, reason };
}
