// Applies one event to a task. Replay runs this alone, so it never judges:
// it records what the event says. An event that doesn't fit the task is
// refused with the reason, so a damaged log stops replay instead of
// rebuilding a wrong task.

import { branchName, phaseRole } from "./task";
import type {
  ActiveState,
  Event,
  Evolved,
  PhaseState,
  SaveResult,
  Stopping,
  Task,
  Workspace,
} from "./types";

const noUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, minutes: 0 };

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
  if (task.id !== event.task) return misfit(event, `it is for task ${event.task}`);
  const state = task.state;
  if (state.phase === "ended") return misfit(event, "the task has ended");
  return active(task, state, event);
}

function active(task: Task, state: ActiveState, event: Event): Evolved {
  const step = state.step;
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

    case "session.stopping": {
      if (step.kind !== "running" || step.session !== event.session) {
        return misfit(event, "that session isn't running");
      }
      // The agent is let go, so its question and your attachment go too.
      const { question: _, ...rest } = state;
      const stopping: Stopping = { kind: "stopping", session: event.session, reason: event.reason };
      switch (rest.phase) {
        case "triage":
          return ok({ ...task, state: { ...rest, attached: false, step: stopping } });
        case "build":
          return ok({ ...task, state: { ...rest, attached: false, step: stopping } });
        case "review":
          if (rest.step.kind !== "running") return misfit(event, "unreachable");
          return ok({
            ...task,
            state: { ...rest, attached: false, step: { ...stopping, copy: rest.step.copy } },
          });
      }
      return misfit(event, "unknown phase");
    }

    case "task.triaged": {
      if (state.phase !== "triage" || state.step.kind !== "stopping") {
        return misfit(event, "the planner isn't being stopped");
      }
      const outcome = event.outcome;
      if (outcome.kind === "proceed") {
        const { kind: _, ...proceed } = outcome;
        return ok({ ...task, state: { ...state, step: { ...state.step, proceed } } });
      }
      return misfit(event, "not built yet");
    }

    case "session.ended": {
      if (step.kind !== "stopping" || step.session !== event.session) {
        return misfit(event, "that session isn't being stopped");
      }
      switch (state.phase) {
        case "triage":
          return ok({
            ...task,
            state: { ...savedIn(state, event.save), step: { kind: "queued" } },
          });
        case "build": {
          const handover =
            state.step.kind === "stopping" && state.step.handover !== undefined
              ? { handover: state.step.handover }
              : {};
          return ok({
            ...task,
            state: { ...savedIn(state, event.save), step: { kind: "queued", ...handover } },
          });
        }
        case "review":
          if (state.step.kind !== "stopping") return misfit(event, "unreachable");
          return ok({
            ...task,
            state: { ...state, step: { kind: "queued", copy: state.step.copy } },
          });
      }
      return misfit(event, "unknown phase");
    }

    case "task.held":
      return ok({ ...task, state: { ...state, hold: event.hold } });

    case "workspace.requested": {
      if (step.kind !== "queued") return misfit(event, `the step is ${step.kind}`);
      if (event.request !== task.requests + 1) return misfit(event, "its request is out of order");
      return ok({
        ...task,
        requests: event.request,
        state: withStep(state, { kind: "creating_workspace", request: event.request }),
      });
    }

    case "workspace.created": {
      if (step.kind !== "creating_workspace" || step.request !== event.request) {
        return misfit(event, "the task isn't creating that workspace");
      }
      if (state.phase === "review") {
        const copy = { request: event.request, path: event.path, commit: state.reviewed.commit };
        return ok({ ...task, state: { ...state, step: { kind: "queued", copy } } });
      }
      const workspace = {
        request: event.request,
        path: event.path,
        branch: branchName(task),
        unsaved: false,
      };
      return ok({ ...task, state: { ...state, workspace, step: { kind: "queued" } } });
    }

    case "workspace.failed":
      if (step.kind !== "creating_workspace" || step.request !== event.request) {
        return misfit(event, "the task isn't creating that workspace");
      }
      return ok({ ...task, state: withStep(state, { kind: "queued" }) });

    case "session.requested": {
      if (event.request !== task.requests + 1) return misfit(event, "its request is out of order");
      const { lifted: _, ...rest } = state;
      const request = event.request;
      switch (rest.phase) {
        case "triage":
          if (step.kind !== "queued") return misfit(event, `the step is ${step.kind}`);
          return ok({
            ...task,
            requests: request,
            state: { ...rest, step: { kind: "starting", request } },
          });
        case "build":
          if (step.kind !== "queued") return misfit(event, `the step is ${step.kind}`);
          return ok({
            ...task,
            requests: request,
            state: { ...rest, step: { kind: "starting", request, intent: rest.intent } },
          });
        case "review":
          if (rest.step.kind !== "queued" || rest.step.copy === undefined) {
            return misfit(event, "the tester has no copy");
          }
          return ok({
            ...task,
            requests: request,
            state: { ...rest, step: { kind: "starting", request, copy: rest.step.copy } },
          });
      }
      return misfit(event, "unknown phase");
    }

    case "session.started": {
      const role = phaseRole(task);
      if (step.kind !== "starting" || step.request !== event.session || role === undefined) {
        return misfit(event, "the task isn't starting that session");
      }
      const record = { session: event.session, role, harnessId: event.harnessId, usage: noUsage };
      const sessions = [...task.sessions, record];
      const session = event.session;
      switch (state.phase) {
        case "triage":
          return ok({ ...task, sessions, state: { ...state, step: { kind: "running", session } } });
        case "build":
          if (state.step.kind !== "starting") return misfit(event, "unreachable");
          return ok({
            ...task,
            sessions,
            state: { ...state, step: { kind: "running", session, intent: state.step.intent } },
          });
        case "review":
          if (state.step.kind !== "starting") return misfit(event, "unreachable");
          return ok({
            ...task,
            sessions,
            state: { ...state, step: { kind: "running", session, copy: state.step.copy } },
          });
      }
      return misfit(event, "unknown phase");
    }

    case "session.failed":
      if (step.kind !== "starting" || step.request !== event.request) {
        return misfit(event, "the task isn't starting that session");
      }
      if (state.phase === "review" && state.step.kind === "starting") {
        return ok({
          ...task,
          state: { ...state, step: { kind: "queued", copy: state.step.copy } },
        });
      }
      return ok({ ...task, state: withStep(state, { kind: "queued" }) });

    default:
      return misfit(event, "not built yet");
  }
}

// Records how a save in the task's workspace went. A failed save marks
// it unsaved, and the next save that works clears the mark.
function savedIn<S extends { workspace?: Workspace }>(state: S, save: SaveResult): S {
  if (state.workspace === undefined) return state;
  return { ...state, workspace: { ...state.workspace, unsaved: save === "failed" } };
}

// Sets a step every phase has.
function withStep(
  state: ActiveState,
  step: { kind: "queued" } | { kind: "creating_workspace"; request: number },
): PhaseState {
  switch (state.phase) {
    case "triage":
      return { ...state, step };
    case "build":
      return { ...state, step };
    case "review":
      return { ...state, step };
  }
}

function ok(task: Task): Evolved {
  return { ok: true, task };
}

function misfit(event: Event, why: string): Evolved {
  return { ok: false, reason: `${event.type} doesn't fit: ${why}` };
}
