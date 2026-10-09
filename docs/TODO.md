# To do

The tasks for the current milestone in `docs/ROADMAP.md`, roughly in order. Tick a task in
the commit that finishes it. When a milestone is done, its tasks go, and the next one is
split into tasks here.

## Open from the core

The core was rebuilt with the spec, code and review skills. These come from its reviews and
from decisions Simon made since. Each goes through the skills, tests first.

- [ ] **Review the decisions** in `docs/core.md`, "Decisions made while building the core".
      Simon's. The ones that change behaviour are below already.
- [ ] **An attached task is left alone.** While you are attached, the agent's `done`, a
      tester's pass and a request for changes are refused with a reason. Progress and
      questions still work. Detaching moves the task on. Simon's call, as the spec's Chat
      mode says. Today the core hears them as usual.
- [ ] **A change during a delivery is refused.** Once a delivery is under way, `skel set` of
      approval or intent is refused with "the delivery is already under way". Simon's call,
      now in the spec. Today it is accepted and has no effect. The decisions in
      `docs/core.md` that say "too late" change with it.
- [ ] **Your answer survives attach and detach.** Reply, attach, then detach with resume:
      the answer is lost and the agent waits for ever. Found by Fable.
- [ ] **A question asked while you are attached** can't be answered after you detach.
      Found by Fable.
- [ ] **Light rigor set while the planner stops** still gives the build the planner's spec.
      The spec says never a spec for light. Found by Fable and by the blind review.
- [ ] **Setting approval again after you approved** makes the task ask you a second time.
      Found by Fable.
- [ ] **Refusing events that don't fit is barely tested.** No test sends `evolve` an event
      that doesn't fit, so a damaged log may replay. Found by mutation testing. Add a
      property test that sends random misfits and checks each is refused.
- [ ] **Tidy the core** without changing behaviour: placeholder "not built yet" defaults,
      "unreachable" branches, helpers whose branches are the same, optional fields where
      `AGENTS.md` asks for `null`, and few comments that say why. Found by Fable.
- [ ] **Reconcile the spec's "the reducer is a few hundred lines"** with the core's real
      size, by changing the promise or splitting the code.

## Milestone 2: store and loop

Split into tasks with the `writing-specs` skill when the milestone starts.

## Later

- **Picking some of a split's proposals**, rather than all or none, waits for a way to
  show them, such as the TUI.
