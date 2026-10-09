// Applies one event to a task. Replay runs this alone, so it never judges:
// it records what the event says. An event that doesn't fit the task is
// refused with the reason, so a damaged log stops replay instead of
// rebuilding a wrong task.

import { branchName, phaseRole } from "./task";
import type {
  ActiveState,
  BuildState,
  EndedState,
  Event,
  Evolved,
  LastStep,
  Leftover,
  Outcome,
  PhaseState,
  Proposal,
  ProposalState,
  ReviewState,
  SaveResult,
  Stopping,
  Task,
  Verdict,
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
      const { agent, ...rest } = state;
      return ok({ ...task, state: agent.save ? savedIn(rest, event.save) : rest });
    }
    case "session.started": {
      if (state.agent?.kind !== "starting" || state.agent.request !== event.session) {
        return misfit(event, "the task isn't starting that session");
      }
      const record = {
        session: event.session,
        role: state.agent.role,
        harnessId: event.harnessId,
        usage: noUsage,
      };
      return ok({ ...task, sessions: [...task.sessions, record] });
    }
    case "session.stopping": {
      if (state.agent?.kind !== "starting" || state.agent.request !== event.session) {
        return misfit(event, "the task isn't starting that session");
      }
      const agent: Leftover = {
        kind: "stopping",
        session: event.session,
        reason: event.reason,
        save: event.save,
      };
      return ok({ ...task, state: { ...state, agent } });
    }
    case "session.failed": {
      if (state.agent?.kind !== "starting" || state.agent.request !== event.request) {
        return misfit(event, "the task isn't starting that session");
      }
      const { agent: _, ...rest } = state;
      return ok({ ...task, state: rest });
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
  const role = phaseRole(task);
  const save = state.phase === "build" && state.intent !== "answer";
  const agent: Leftover | undefined =
    step.kind === "starting" && role !== undefined
      ? { kind: "starting", request: step.request, role, save }
      : step.kind === "stopping"
        ? { kind: "stopping", session: step.session, reason: step.reason, save: step.save }
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
        if (state.step.kind !== "queued")
          return misfit(event, `the build step is ${state.step.kind}`);
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
      if (step.kind !== "queued" && step.kind !== "awaiting_approval") {
        return misfit(event, `build can't start while the step is ${step.kind}`);
      }
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
      const live =
        (step.kind === "running" && step.session === event.session) ||
        (step.kind === "starting" && step.request === event.session);
      if (!live) return misfit(event, "that session isn't running or starting");
      // The agent is let go, so its question and your attachment go too.
      const { question: _, ...rest } = state;
      const stopping: Stopping = {
        kind: "stopping",
        session: event.session,
        reason: event.reason,
        save: event.save,
      };
      switch (rest.phase) {
        case "triage":
          return ok({ ...task, state: { ...rest, attached: false, step: stopping } });
        case "build":
          return ok({ ...task, state: { ...rest, attached: false, step: stopping } });
        case "review":
          if (rest.step.kind !== "running" && rest.step.kind !== "starting") {
            return misfit(event, "unreachable");
          }
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
      if (state.step.proceed !== undefined) return misfit(event, "triage already has its call");
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
            state: {
              ...savedIn(state, step.kind === "stopping" && step.save ? event.save : undefined),
              step: { kind: "queued" },
            },
          });
        case "build": {
          const handover =
            state.step.kind === "stopping" && state.step.handover !== undefined
              ? { handover: state.step.handover }
              : {};
          return ok({
            ...task,
            state: {
              ...savedIn(state, step.kind === "stopping" && step.save ? event.save : undefined),
              step: { kind: "queued", ...handover },
            },
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

    case "review.passed":
    case "review.changes_requested": {
      if (state.phase !== "review" || state.step.kind !== "stopping") {
        return misfit(event, "the tester isn't being stopped");
      }
      if (state.step.session !== event.session) return misfit(event, "it is another session's");
      if (state.step.verdict !== undefined) return misfit(event, "the verdict is already in");
      const verdict: Verdict =
        event.type === "review.passed"
          ? { kind: "pass", evidence: event.evidence }
          : { kind: "changes", findings: event.findings };
      return ok({ ...task, state: { ...state, step: { ...state.step, verdict } } });
    }

    case "workspace.removed": {
      if (state.workspace?.request === event.request) {
        if (state.phase === "review") return misfit(event, "review needs its workspace");
        const { workspace: _, ...rest } = state;
        return ok({ ...task, state: rest });
      }
      if (
        state.phase === "review" &&
        state.step.kind === "queued" &&
        state.step.copy?.request === event.request
      ) {
        return ok({ ...task, state: { ...state, step: { kind: "queued" } } });
      }
      return misfit(event, "the task doesn't hold that workspace, or it is in use");
    }

    case "output.ready": {
      if (state.phase === "triage") return misfit(event, "triage has no output");
      if (step.kind !== "queued" && step.kind !== "awaiting_approval") {
        return misfit(event, `the step is ${step.kind}`);
      }
      const ready: LastStep = { kind: "ready", output: event.output, critical: event.critical };
      return ok({ ...task, state: withLast(state, ready) });
    }

    case "approval.requested":
      if (state.phase === "triage" || state.step.kind !== "ready") {
        return misfit(event, "the output isn't ready");
      }
      return ok({
        ...task,
        state: withLast(state, { ...state.step, kind: "awaiting_approval" }),
      });

    case "approval.given":
      if (state.phase === "triage" || state.step.kind !== "awaiting_approval") {
        return misfit(event, "the task isn't waiting for approval");
      }
      return ok({ ...task, state: withLast(state, { ...state.step, kind: "ready" }) });

    case "approval.denied":
      if (step.kind !== "awaiting_approval")
        return misfit(event, "the task isn't waiting for approval");
      return ok(task);

    case "output.requested":
      if (state.phase === "triage" || state.step.kind !== "ready") {
        return misfit(event, "the output isn't ready");
      }
      if (event.request !== task.requests + 1) return misfit(event, "its request is out of order");
      return ok({
        ...task,
        requests: event.request,
        state: withLast(state, { ...state.step, kind: "delivering", request: event.request }),
      });

    case "output.failed":
      if (state.phase === "triage" || state.step.kind !== "delivering") {
        return misfit(event, "the task isn't delivering");
      }
      if (state.step.request !== event.request) return misfit(event, "it answers another request");
      return ok({
        ...task,
        state: withLast(state, {
          kind: "ready",
          output: state.step.output,
          critical: state.step.critical,
        }),
      });

    case "output.delivered": {
      if (state.phase === "triage" || state.step.kind !== "delivering") {
        return misfit(event, "the task isn't delivering");
      }
      if (state.step.request !== event.request) return misfit(event, "it answers another request");
      const work = state.phase === "review" ? state.handover.work : undefined;
      const proposals = work?.kind === "report" ? work.proposals : [];
      return end(task, state, { kind: "done", output: state.step.output }, proposals);
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
      if (state.step.handover !== undefined)
        return misfit(event, "the work is already handed over");
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

    case "task.paused":
      if (state.hold !== undefined) return misfit(event, "the task is already held");
      return ok({ ...task, state: { ...state, hold: { kind: "paused" } } });

    case "task.resumed": {
      const { hold, ...rest } = state;
      if (hold === undefined) return misfit(event, "the task isn't held");
      if (event.via === "resume" && hold.kind !== "paused") return misfit(event, "it isn't paused");
      return ok({ ...task, state: { ...rest, lifted: hold } });
    }

    case "task.killed":
      return end(task, state, { kind: "killed" }, []);

    case "task.failed":
      return end(task, state, { kind: "failed" }, []);

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
function savedIn<S extends { workspace?: Workspace }>(state: S, save: SaveResult | undefined): S {
  if (state.workspace === undefined || save === undefined) return state;
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

// Sets one of the last steps, which build and review share.
function withLast(state: BuildState | ReviewState, step: LastStep): PhaseState {
  return state.phase === "build" ? { ...state, step } : { ...state, step };
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
