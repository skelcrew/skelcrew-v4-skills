// Applies one event to a task. Replay runs this alone, so it never judges:
// it records what the event says. An event that doesn't fit the task is
// refused with the reason, so a damaged log stops replay instead of
// rebuilding a wrong task.

import { branchName, phaseRole } from "./task";
import type {
  ActiveState,
  EndedState,
  Event,
  Evolved,
  Leftover,
  Outcome,
  PhaseState,
  Proposal,
  ProposalState,
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
  if (state.phase === "ended") return ended(task, state, event);
  return active(task, state, event);
}

// An ended task records only cleanup, usage and decisions on proposals.
function ended(task: Task, state: EndedState, event: Event): Evolved {
  switch (event.type) {
    case "session.ended": {
      if (state.agent?.kind !== "stopping" || state.agent.session !== event.session) {
        return misfit(event, "that session isn't being stopped");
      }
      const { agent: _, ...rest } = state;
      return ok({ ...task, state: savedIn(rest, event.save) });
    }
    case "workspace.removed": {
      const { workspace, copy, ...rest } = state;
      const keep = {
        ...(workspace === undefined || workspace.request === event.request ? {} : { workspace }),
        ...(copy === undefined || copy.request === event.request ? {} : { copy }),
      };
      if (workspace?.request !== event.request && copy?.request !== event.request) {
        return misfit(event, "the task doesn't hold that workspace");
      }
      return ok({ ...task, state: { ...rest, ...keep } });
    }
    case "proposals.approved":
    case "proposals.denied": {
      const decision: ProposalState["decision"] =
        event.type === "proposals.approved" ? "approved" : "denied";
      for (const index of event.which) {
        if (state.proposals[index]?.decision !== "pending") {
          return misfit(event, `proposal ${index} isn't pending`);
        }
      }
      const proposals = state.proposals.map((p, index) =>
        event.which.includes(index) ? { ...p, decision } : p,
      );
      return ok({ ...task, state: { ...state, proposals } });
    }
    default:
      return misfit(event, "the task has ended");
  }
}

// The task ends. It keeps what its agent still runs in, and the agent
// itself if it is starting or stopping, so the cleanup can finish.
function end(task: Task, state: ActiveState, outcome: Outcome, proposals: Proposal[]): Evolved {
  const step = state.step;
  const agent: Leftover | undefined =
    step.kind === "starting"
      ? { kind: "starting", request: step.request }
      : step.kind === "stopping"
        ? { kind: "stopping", session: step.session, reason: step.reason }
        : undefined;
  const copy = "copy" in step ? step.copy : undefined;
  return ok({
    ...task,
    state: {
      phase: "ended",
      outcome,
      proposals: proposals.map((p) => ({ ...p, decision: "pending" })),
      ...(agent === undefined ? {} : { agent }),
      ...(state.workspace === undefined ? {} : { workspace: state.workspace }),
      ...(copy === undefined ? {} : { copy }),
    },
  });
}

function active(task: Task, state: ActiveState, event: Event): Evolved {
  const step = state.step;
  switch (event.type) {
    case "phase.started": {
      if (event.phase === "review") {
        if (state.phase !== "build" || state.workspace === undefined) {
          return misfit(event, "review starts from build, with a workspace");
        }
        return ok({
          ...task,
          state: {
            phase: "review",
            intent: state.intent,
            rigor: state.rigor,
            approve: state.approve,
            brief: state.brief,
            ...(state.spec === undefined ? {} : { spec: state.spec }),
            loops: state.loops,
            workspace: state.workspace,
            handover: event.handover,
            reviewed: event.reviewed,
            step: { kind: "queued" },
            attached: false,
            ...holdsOf(state),
          },
        });
      }
      if (state.phase === "build") return misfit(event, "the task is already in build");
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
          ...holdsOf(state),
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
      if (outcome.kind === "split") return end(task, state, { kind: "split" }, outcome.proposals);
      return end(task, state, { kind: "declined", reason: outcome.reason }, []);
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

    case "progress.reported":
      if (step.kind !== "running" || step.session !== event.session) {
        return misfit(event, "that session isn't running");
      }
      return ok(task);

    case "build.done":
      if (state.phase !== "build" || state.step.kind !== "stopping") {
        return misfit(event, "the builder isn't being stopped");
      }
      return ok({
        ...task,
        state: { ...state, step: { ...state.step, handover: event.handover } },
      });

    case "main.requested":
      if (state.phase !== "build" || state.step.kind !== "queued" || !state.step.handover) {
        return misfit(event, "there is no handed-over work to merge");
      }
      if (event.request !== task.requests + 1) return misfit(event, "its request is out of order");
      return ok({
        ...task,
        requests: event.request,
        state: {
          ...state,
          step: { kind: "merging", request: event.request, handover: state.step.handover },
        },
      });

    case "main.merged":
    case "main.failed":
      if (state.phase !== "build" || state.step.kind !== "merging") {
        return misfit(event, "the task isn't merging");
      }
      if (state.step.request !== event.request) return misfit(event, "it answers another request");
      return ok({
        ...task,
        state: { ...state, step: { kind: "queued", handover: state.step.handover } },
      });

    case "main.conflict":
      if (state.phase !== "build" || state.step.kind !== "merging") {
        return misfit(event, "the task isn't merging");
      }
      if (state.step.request !== event.request) return misfit(event, "it answers another request");
      return ok({
        ...task,
        state: {
          ...state,
          loops: state.loops + 1,
          handback: { kind: "conflict" },
          step: { kind: "queued" },
        },
      });

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

// A hold, and the hold last lifted, belong to the task, not its phase, so
// they stay when the phase changes.
function holdsOf(state: ActiveState): Pick<ActiveState, "hold" | "lifted"> {
  return {
    ...(state.hold === undefined ? {} : { hold: state.hold }),
    ...(state.lifted === undefined ? {} : { lifted: state.lifted }),
  };
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
