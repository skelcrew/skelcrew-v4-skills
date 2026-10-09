// Applies one event to a task. Replay runs this alone, so it never judges:
// it records what the event says. An event that doesn't fit the task is
// refused with the reason, so a damaged log stops replay instead of
// rebuilding a wrong task.

import type { Event, Evolved, Task } from "./types";

export function evolve(task: Task | undefined, event: Event): Evolved {
  if (event.type === "task.received") {
    if (task !== undefined) return misfit(event, "the task already exists");
    return ok({
      id: event.task,
      source: event.source,
      title: event.title,
      description: event.description,
      receivedAt: event.at,
      requests: 0,
      sessions: [],
      state: {
        phase: "triage",
        overrides: event.overrides,
        step: { kind: "queued" },
        attached: false,
      },
    });
  }
  if (task === undefined) return misfit(event, "there is no such task");
  const state = task.state;
  switch (event.type) {
    case "phase.started": {
      if (event.phase !== "build") return misfit(event, "not built yet");
      if (state.phase !== "triage") return misfit(event, `the task is in ${state.phase}`);
      return ok({
        ...task,
        state: {
          phase: "build",
          intent: event.intent,
          rigor: event.rigor,
          approve: event.approve,
          brief: event.brief,
          ...(event.spec === undefined ? {} : { spec: event.spec }),
          loops: event.loops,
          ...(event.workspace === undefined ? {} : { workspace: event.workspace }),
          ...(event.handback === undefined ? {} : { handback: event.handback }),
          step: { kind: "queued" },
          attached: false,
        },
      });
    }
    default:
      return misfit(event, "not built yet");
  }
}

function ok(task: Task): Evolved {
  return { ok: true, task };
}

function misfit(event: Event, why: string): Evolved {
  return { ok: false, reason: `${event.type} doesn't fit: ${why}` };
}
