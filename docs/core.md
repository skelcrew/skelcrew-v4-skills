# Core model

**Status: approved.** This is the core from `docs/spec.md`, worked out in enough detail to
write tests against. It holds no code. The rules it must never break are in
`docs/invariants.md`.

## A task

A task is always in one **phase**: triage, build, review, or ended. Each phase carries only
the data it needs, and has its own small **step** machine. A step that waits on a reply holds
its request number.

On top of the phase, a task can have:

- **an open question**: an agent asked, and waits for your answer
- **a hold**: its agent is stopped, and it won't start again until you act. The hold says
  why: you paused it, the agent crashed or gave up, the loop cap was reached, or a command
  failed. Skelcrew never retries on its own.
- **you attached**: you are in its session

None of these changes the phase. When the question is answered or the hold is lifted, the
task carries on in the same phase and step.

**Waiting on you** is a view, not a state: a task with an open question, one awaiting
approval, or one held for any reason but a pause.

### What each phase holds

| Phase | Holds |
|---|---|
| triage | the workspace and the planner's session, once they exist |
| build | intent, rigor, approval flag, brief, spec path, the workspace, the builder's session, the loop count |
| review | everything build holds, plus the reviewed commit, the task's changed files, and the tester's copy and session |
| ended | the outcome (done, split, declined, killed, failed), what was handed over, and any proposals with your decisions on them |

Every task also holds its ID, source and source ID, title, request counter and usage.

### One workspace per task

The task's workspace is created when triage starts, as a worktree on a new branch from main,
such as `skel/142-empty-export`. If triage is skipped, it is created at the start of build
instead. The planner works in it read only. If it writes a spec, Skelcrew commits the spec to
the branch as `docs/plans/142-empty-export.md`. The builder then works in the same worktree.

A split or a decline removes the workspace and the branch.

### The tester's copy

The tester gets a separate detached copy at the reviewed commit. It is writable, since
`setup` and the tests write files such as installed packages and caches. It is never
committed, nothing in it flows back, and it is thrown away after the verdict.

### Where agents write files

No role may write anywhere outside its permissions. So the planner and tester, which have no
edit permission on the task's code, need somewhere to put a brief, findings or evidence
before passing them to a `skel` command. Each session may write to `.skelcrew/out/` in its
workspace, which git ignores. The daemon reads the file when the command arrives, and stores
its text in the event.

## Steps

### Triage

1. **queued**: waits for a slot.
2. **creating workspace** (request): the worktree and branch are being made.
3. **starting** (request): the planner's session is starting.
4. **running** (session): the planner works.

Triage ends with one of:

- **proceed**: the planner is stopped. Once the stop is confirmed, the task moves to build,
  keeping its slot.
- **split**: the planner is stopped, and the proposals wait for you. The task ends as split,
  and its workspace and branch are removed.
- **decline**: the planner is stopped. The task ends as declined, with the reason. Its
  workspace and branch are removed.

The planner can also **ask**. That doesn't end triage.

### Build

1. **queued**: waits for a slot. A task gets here when triage was skipped, after a hold is
   lifted, or after a change of intent.
2. **creating workspace** (request): only when triage was skipped.
3. **starting** (request): the builder's session is starting.
4. **running** (session): the builder works.
5. **handed over**: the builder ran `skel done`. The daemon attaches what the branch holds:
   its head commit, and every file the branch changed since it left main. The builder never
   supplies these. The builder is stopped. If review asks for changes, a fresh builder
   starts with the findings.
6. **merging main** (request): only for `ship` and `try`. The reply is one of:
   - **merged**: with the resulting commit and the task's changed files. That commit is the
     **reviewed commit**.
   - **conflict**: the merge is left unfinished, and the builder gets it back. That counts as
     a loop.
   - **failed**: git failed for another reason, such as a lock. The task is held.

For `answer`, which merges nothing, the reviewed commit is the handed-over one.

When triage was skipped, the brief is the task's title and description.

After build:

- `ship` and `answer` move to review, keeping the task's slot.
- `try` skips review. It goes to approval if it needs it, otherwise to delivery.

### Review

1. **creating workspace** (request): the tester's copy at the reviewed commit.
2. **starting** (request): the tester's session is starting.
3. **running** (session): the tester works.

The verdict:

- **pass**: the tester is stopped and its copy removed. Then approval if the task needs it,
  otherwise delivery.
- **changes**: the tester is stopped and its copy removed. The loop count goes up. Under the
  cap, the task is back in build, and a fresh builder starts with the findings once the
  tester's stop is confirmed. At the cap, the task is held with the findings.

### Approval and delivery

These are the last steps of whichever phase ran last: review, or build for `try`.

- **awaiting approval**: reached when the task has the approval flag, or when its changed
  files touch a file matching `critical` in config. The core checks the changed files
  itself, so a planner that judged wrong can't skip it. No agent runs, so no slot is held.
  `skel approve` moves on to delivery. `skel deny 142 "why"` sends the task back to build
  with your note. A denial doesn't count as a loop, since it isn't a failure.
- **delivering** (request): the output plugin hands over exactly the reviewed commit, as a
  branch, a PR or a report. Anything committed after it stays out. A failed delivery holds
  the task. The task ends as done only when delivery is confirmed.

### Stopping an agent

An agent is stopped whenever it is replaced, let go, paused, held or killed. A stop always
goes in this order:

1. The session is stopped.
2. If its workspace can hold edits, any uncommitted work is committed.
3. The reply says **stopped**, with one of: saved, nothing to save, or save failed.

The next agent on the task starts only once the stop is confirmed, and the task keeps its
slot until then. If the save failed, the task is held with "its work couldn't be saved", and
its workspace is never removed.

### Handover

`skel done` answers at once, and the builder is stopped. The task keeps its slot for the
tester. If review asks for changes, a fresh builder starts with the findings. Claude Code
moves a shell command to the background after 2 minutes, so a `done` that waited for the
verdict would quietly stop waiting.

### Questions

- **Asking.** The agent runs `skel ask` and ends its turn. The question opens, and the task
  gives up its slot.
- **Answering.** Your answer is kept until a slot is free, then typed into the session.
- **Losing the agent.** If the session ends, the question goes with it. A fresh session may
  ask again.

### Changing intent, rigor or approval

`skel set` overrules the planner's call. It is never refused for timing: while a workspace
or session is starting, or main is merging, it waits until the step settles, then applies.

- **Approval applies at once.** Setting it stops a task before delivery. Clearing it on a
  task awaiting approval sends it on to delivery, unless its changed files still touch a
  critical path.
- **Rigor applies from the next phase.** A running build or review carries on. The next
  review uses the new depth. A change to `full` mid-build adds no spec.
- **Intent restarts build.** The builder is stopped and a fresh session starts, on the same
  branch and in the same workspace, since the permissions change. Commits already on the
  branch stay, and the loop count is kept. After a change to `answer`, the code stays on the
  branch, and only the report is handed over.
- **During triage, intent and rigor together end triage**, as `skel add --ship --light`
  skips it. The planner is stopped and build starts. Either one alone wins over what the
  planner proposes for that field.

## Slots

- **A task keeps its slot across phase changes.** It gives the slot up only when it waits on
  you, is held, or ends. So work already under way finishes before new work starts.
- **An attached task keeps its slot**, since its agent keeps working with you.
- **Starts and stops in flight hold a slot**, as the spec says.
- **The scheduler's order:** answers to questions, then resumed tasks, then queued tasks.
  Oldest first within each.
- **You can go past `max_running`.** `skel start 145` starts at once, even when every slot
  is taken. The limit binds only what Skelcrew starts on its own.

## Inputs

Inputs are typed by sender. The boundary that receives a call sets the sender, never the
caller.

### From you

| Input | Does |
|---|---|
| add | a new task. Intent and rigor given together skip triage. |
| set | changes intent, rigor or approval. Each takes effect in its own way, see Changing intent, rigor or approval. |
| reply | answers the open question. Waits for a slot before it reaches the agent. |
| approve / deny | signs off a task, or sends it back to build with a note |
| approve proposals / deny proposals | on tasks proposed by a split or an answer, after the task has ended |
| attach / detach | steps into the session, and back out with resume or hand over |
| pause / resume | holds the task, or lifts your pause |
| start | starts the task now, even past `max_running` |
| retry | lifts a hold, whatever its reason |
| kill | ends the task |

A reply on the tracker, through an input plugin, counts as yours only when it comes from an
account configured as yours. That is the one plugin input that carries one of your
decisions.

### From agents

Each agent input names its session. Only the session the task's step holds is heard, and only
for its own role.

| Role | Inputs |
|---|---|
| planner | triage proceed, triage split, triage decline, ask, give up |
| builder | ask, progress, done (summary, or report and proposed tasks for `answer`), give up |
| tester | pass with evidence, changes with findings, ask, give up |

### From plugins

- **Task sources:** a task arrived.
- **Outside changes:** an issue closed, reopened or relabelled in the tracker. Always
  refused. Tasks move only through Skelcrew.
- **Replies to commands**, listed with each command below. A reply for a request the task no
  longer waits on is late. It is accepted with only the commands that clean up after it,
  such as stopping a session that started late, and changes nothing else.

### From the daemon

- **start**: the scheduler picked the task for a free slot.
- **deliver answer**: the scheduler found a slot for a kept answer.
- **usage**: each session's running totals, read from its transcript. The task's usage is
  the sum. It is shown, never enforced.

How long an agent has been quiet is read from its transcript and shown on the screen. It is
not an input, since nothing in the core acts on it.

## Commands

Each command that expects a reply carries the task's next request number. Every command with
a reply has a success reply and a failure reply.

| Command | Replies |
|---|---|
| create workspace (the task's, or the tester's copy at a commit) | created, failed |
| remove workspace | none |
| start session (role, workspace, brief, findings or answer to pass on) | started, failed, and later ended |
| stop session (save work or not) | stopped: saved, nothing to save, or save failed |
| type into session | none |
| merge main | merged with the commit and changed files, conflict, failed |
| deliver output (the reviewed commit, or the report) | delivered, failed |

**No retries.** A failure reply holds the task with what happened. You retry it with
`skel retry`.

**Repeats after a crash.** The outbox may send a command twice, and each tool treats a repeat
as doing nothing. Typing into a session is the exception. It is recorded as sent before it
is typed, so a crash in between loses the message rather than typing it twice. A lost
message shows as an idle agent, and you can reply again.

Output plugins that only mirror state, such as an issue comment or a notification, listen to
events. They never block a task, and the core sends them no command.

## Decisions made while building the core

The human did not review these as they were made. Each one is a call the docs above left
open, or a detail they didn't pin down. The core was built against them.

### Part 1: the types

The types live in `src/core/types.ts`. This part says what they hold and why.

**Names for things**

- **A request number names what it asked for.** A workspace is named by the number of the
  request that created it. A session is named by the number of the request that started it.
  So an agent's input names its session as that number, and a report that a session ended
  does too. The harness's own session ID is the plugin's business. It comes back with the
  start reply, and the task keeps it for finding the transcript.
- **A stop has no request number of its own.** It names the session it stops, and its reply
  names that session too. A session is stopped once, so its number is enough. This keeps a
  cleanup stop, sent for a session that started late, from changing the task's counter.
- **The task's branch name is worked out by the core**, from the task ID and title, such as
  `skel/142-empty-export`. The same task always gets the same name.
- **The core never makes up a task ID.** `add` and a task source's arrival carry the ID.
  Approved proposals become tasks through the task source: the core sends a command to add
  them, and each comes back as a normal arrival with its own ID. This keeps every event on
  the task that caused it.

**The task**

- A task holds its ID, source, title, description, when it arrived, its request counter and
  its sessions with their usage. Then one state for its phase.
- The phase states are triage, build, review and ended. Triage, build and review also hold
  the open question, the hold, the hold last lifted, and whether you are attached.
- **Every step that can't exist without some data carries that data.** A running step holds
  its session. A merge holds the handed-over work. A tester's step holds its copy. So a
  tester without a copy can't be written down.
- **The queued step is the resting step.** A task is queued when no agent runs and no request
  is in flight. What it does next follows from what it holds. In build, a queued task with
  handed-over work merges main next. Without it, a builder starts next.
- **Build and review share their plan:** intent, rigor, the approval flag, the brief, the
  spec and the loop count. Review also holds the handed-over work and the reviewed commit.
- **`try` ends in build.** Its approval and delivery steps carry the handed-over work and the
  reviewed commit, since build has no other place for them.
- **An ended task can still owe one cleanup.** When a task ends while its agent is starting
  or stopping, it keeps that agent and the workspace the agent runs in. A start is stopped
  once it answers. Once the stop is confirmed and saved, the workspace is removed. If the
  save failed, the workspace is kept for good. Without this, killing a task while its
  session starts would remove the workspace under the session coming up.

**Holds**

- A hold is one of: paused, crashed (exit code and last line), gave up (the reason), loop
  cap (the findings), a failed workspace, session, merge or delivery (the error), or work
  that couldn't be saved.
- **A new hold replaces an old one.** A paused task whose stop then fails to save is held as
  unsaved, so it shows as waiting on you.
- **A held task sends no new request.** No workspace, session, merge or delivery starts while
  it is held. Stops and removals still go out, since they only clean up.
- **The hold last lifted is kept until the next session starts.** The scheduler reads it to
  put resumed tasks first, and the new session is told why it is back.

**Inputs**

Every input carries its task ID, its moment and its sender. The sender is you, an agent, a
plugin or the daemon.

| Sender | Inputs |
|---|---|
| you | add, set, reply, approve, deny, approve proposals, deny proposals, attach, detach, pause, resume, start, retry, kill |
| agent | proceed, split, decline (planner); progress, done (builder); pass, changes (tester); ask and give up (any role). Each names its session and role. |
| plugin | task arrived, outside change, tracker reply, and the replies: workspace created or failed, session started, failed, ended or stopped, main merged, conflict or failed, output delivered or failed |
| daemon | start, deliver answer, usage |

- **A tracker reply carries the account it came from.** The core accepts it as your answer
  only if config lists that account as yours.
- **The daemon adds facts from git** before the core sees them: the commit and changed files
  on `done` and on a detach that hands over, and the text of every file an agent names.
- **A task source can't set intent, rigor or approval.** Only `add` from you can. Setting
  approval from a tracker label waits for the GitHub plugin.
- **The planner's spec arrives with its path**, chosen by the daemon, and its text.
- **Handing over on detach is only for `ship` and `try`.** The handed-over work is then a
  summary saying you handed it over. An `answer` needs the builder's report, and the core
  can't make one up, so handing it over is refused. Detach with resume instead.

**Events**

Every event carries its type, a version (1 for all of them now), its task and its moment.
The events are the spec's list, plus these, since a state change needs an event and the
spec's list has none for them:

| Event | Why it exists |
|---|---|
| `workspace.requested`, `session.requested`, `main.requested`, `output.requested` | A step that waits on a reply holds its request number. These record the number and the step. |
| `session.stopping` | The agent is let go and its stop is in flight. The task keeps its slot until the stop is confirmed. |
| `approval.requested` | The task now waits for your sign-off. |
| `answer.delivered` | Your kept answer was typed into the session, so the question is closed. |
| `progress.reported` | A builder's progress note, kept in the log for you to read. It changes no state. |
| `usage.reported` | A session's usage totals grew. |

- **`phase.started` is only for build and review.** `task.received` puts a task in triage.
  When triage is skipped, `phase.started` for build follows at once.
- **`task.resumed` covers both resume and retry**, with which one it was.
- **A crash holds the task, and its session still gets a stop.** A crashed session's pane
  stays open, and its uncommitted work still needs saving. So the task is held as crashed,
  and a stop goes out. `session.ended` is recorded when the stop is confirmed. Its reason
  is the one the stop was sent for: `reported` after an agent's report, `stopped` when
  Skelcrew let it go, `crashed` after a crash. It always says how the save went.
- **A crash's exit code is optional.** A session lost while no daemon ran has none, and the
  core never makes one up.

**Commands**

The commands are the ones in Commands above, plus one: **add tasks**, which hands approved
proposals to the task source. It has no reply. Stop session also carries whether to save,
and for the planner after proceed, the spec to write and commit with the save.

- **Starting a session sets its edit permission from the role and intent.** Only a builder
  on a `ship` or `try` task can edit.
- **Delivery says whether the output is mergeable.** `try` is never mergeable.
- **A workspace removed at the end keeps its branch**, so you can still find the work. Only a
  split or a decline deletes the branch too, as the spec says. A late workspace is removed
  without touching any branch.

**Config the core reads**

`max_running`, the `critical` paths, and the tracker accounts that are yours. The loop cap is
fixed at 3, as the spec says. The `critical` paths use glob patterns, matched with Bun's
`Glob`.

**What decide returns**

`decide` returns either accepted, with the events and commands, or refused, with the reason
in plain words. `evolve` returns the new task, or the reason the event doesn't fit. Neither
throws.

**Zod comes with the boundary.** Every outside input is checked with Zod where it arrives:
the CLI, plugins and the saved log. None of those exist in this milestone, so the core's
types are plain TypeScript for now.

**How every input is judged, before its phase**

1. A new task (`add`, or a task source's arrival): refused if the task already exists.
   Otherwise the task is received.
2. Any other input for a task that doesn't exist is refused.
3. An outside change is always refused. Tasks move only through Skelcrew.
4. A reply the task no longer waits on is late. It is accepted with only the commands that
   clean up after it, and records no event:
   - a workspace created late is removed;
   - a session started late is stopped, without saving;
   - every other late reply needs no cleanup.

   A reply that repeats what the task already holds is accepted and does nothing. For
   example, a second "started" for the session that is running doesn't stop it.
5. An ended task accepts only the stop it still waits on, late replies, usage, and your
   decisions on its proposals. Everything else is refused, since nothing leaves an ending.
6. An agent's input is heard only from the session the task's step holds as running. The
   role it claims must be the role that session was started for, and that role must work
   the phase. Everything else is refused.
7. Then the input is judged against the phase and step.

**Stories**

Each story becomes a snapshot test once the core can run it.

1. **Quick fix.** `add --ship --light` skips triage. The scheduler starts it: workspace,
   builder, `done`, merge main, tester, `pass`, delivery. The task ends as done.
2. **Full feature with sign-off.** The planner proceeds with `ship`, `full`, approval and a
   spec. Review asks for changes once. The second review passes. The task waits for you, you
   approve, and it is delivered.
3. **A crash and a retry.** The builder's session crashes. The task is held with the exit
   code, and the stop saves its work. You retry. The task waits for a slot, and a fresh
   builder starts with why it is back.
4. **A question.** The builder asks and the slot frees. You reply. The scheduler delivers the
   answer once a slot is free, and the builder carries on.
5. **A split.** The planner splits the task. It ends as split, and its workspace and branch
   are removed once the planner's stop is confirmed. You approve one proposal, and the task
   source is asked to add it.
6. **A prototype.** A `try` task skips review and is delivered as not mergeable.
7. **A conflict.** Merging main conflicts. The loop count goes up, and a fresh builder gets the
   merge back.
8. **The loop cap.** Review asks for changes three times. The task is held with the findings.
   You kill it, and it ends as failed.
9. **A pause during a start.** You pause while the builder is starting. The start reply
   arrives, the new session is stopped at once, and the task waits held.

**How each invariant is checked**

The property tests drive the core with random inputs, mostly ones the current state accepts.
Replies are built from the commands actually sent, old ones included. A model of the outside
world records which workspaces and sessions really exist. After every step:

| Rule | Check |
|---|---|
| 1 | No accepted input from an agent, plugin or the daemon records one of your events: set, approval, answer (but a tracker reply from your account), proposals, start, pause, resume, kill or failed. |
| 2 | Every accepted agent input came from the running session of a phase its role fits. |
| 3 | An add tasks command goes out only with `proposals.approved`. Nothing but `add` and an arrival records `task.received`. |
| 4 | Every outside change is refused. |
| 5 | A refused input returns no events and no commands. A late reply records no events, and sends only a removal or a stop. |
| 6 | The commit delivered is the reviewed commit. For `ship` and `answer`, it is also the commit the tester's copy was made at. |
| 7 | A `ship` delivery follows a `review.passed` on the same commit. |
| 8 | A delivery of a task with the approval flag, or with a critical file changed, follows an `approval.given` after its last pass, or after its last `build.done` for `try`. |
| 9 | No delivery of a `try` is mergeable. No session on an `answer` task starts with edit permission. |
| 10 | The slots in use never pass `max_running`, except through your start or attach. A start session command goes out only when the task has no live session. |
| 11 | A held task has no running session, and sends no request. |
| 12 | Every failure reply and every crash leaves the task held or ended. |
| 13 | A second ask is refused while a question is open. |
| 14 | Every workspace and session that exists in the world model is held by its task, or has had a removal or stop sent. Everything a task holds exists in the world model. |
| 15 | No removal is sent for a workspace while a session in it is still live, and none after a failed save. A stop of a tester never saves. |
| 18 | An ended task records only cleanup, usage and proposal events. |
| 19 | A crash leaves the task held with its exit code and last line. |
| 20 | An open question's session is the running session. |
| 21 | No session's usage goes down. A lower report is refused. |
| 22 | Folding the task's events through `evolve` from nothing gives the same task. |

Rules 16 and 17 are about the loop and store, which come in the next milestone.

**The parts that follow**

The core is built one part at a time, in this order. Each part's table names the part that
covers an input it leaves out.

| Part | Covers |
|---|---|
| 2 | triage, and your decisions on a split's proposals |
| 3 | build, through handover and merging main |
| 4 | review |
| 5 | approval and delivery |
| 6 | stopping an agent: pause, resume, retry, kill, a crash, giving up, a failed save |
| 7 | attach and detach |
| 8 | questions: ask, reply, a tracker reply, delivering an answer |
| 9 | changing intent, rigor or approval |
| 10 | the scheduler: slots, start, start now, usage |

### Part 2: triage

**Starting triage.** The scheduler's start reaches a queued triage task that isn't held.

- With no workspace, the task's workspace is requested: `workspace.requested` and a create
  workspace command for the task's branch.
- With a workspace already, the planner is requested: `session.requested` and a start
  session command. The planner gets the title and description as its brief, the workspace,
  and no edit permission.

**The table.** A cell names the events, then the commands. "Late" means the general rule for
late replies applies. A planner input in any step but running is refused by the general
rules, since only the running session is heard.

| Step | Input | Result |
|---|---|---|
| queued | start | as above |
| creating workspace | workspace created | `workspace.created`, then the planner is requested |
| creating workspace | workspace failed | `workspace.failed`, then held as a failed workspace |
| starting | session started | `session.started`, the step is running |
| starting | session failed | `session.failed`, then held as a failed session |
| running | proceed | refused with an open question, or with a spec on a `light` call. Otherwise `session.stopping` (reported), then `task.triaged` with the call. A stop that saves, writing the spec first when there is one. |
| running | split | refused with an open question or no proposals. Otherwise `session.stopping` (reported) and `task.triaged`. The task ends as split. A stop that doesn't save. |
| running | decline | refused with an open question or an empty reason. Otherwise as split, ending as declined. |
| stopping | session stopped | `session.ended`. After a proceed: `phase.started` for build, then the builder is requested. A failed save holds the task first (part 6), and then no builder is requested. |
| stopping | session ended | accepted, and nothing happens. The stop in flight will answer. |
| ended, stopping | session stopped | `session.ended`, then `workspace.removed` and a remove command that deletes the branch. The planner's stop doesn't save, so its save result changes nothing (part 6). |
| ended | approve proposals | refused if the list is empty, or names a proposal that doesn't exist or is decided. Otherwise `proposals.approved` and an add tasks command with them. |
| ended | deny proposals | the same checks, then `proposals.denied`. |
| any | pause, resume, retry, kill, give up, a crash | part 6 |
| any | attach, detach | part 7 |
| any | ask, reply, deliver answer | part 8 |
| any | set | part 9 |
| any | start now, usage | part 10 |
| any | other replies | late |

The proceed, split and decline inputs from a builder or tester never reach this table. Their
role doesn't work in triage, so the general rules refuse them.

**Decisions**

- **Your overrides win over the planner's call, field by field.** Build starts with your
  intent, rigor and approval where you gave them, and the planner's otherwise.
- **A spec is refused only when the planner itself calls `light`.** If you set `light` and the
  planner calls `full` with a spec, the spec is kept, since it is already written. The spec
  says a `light` task never gets one. That rule is about the planner's own call.
- **The planner's stop saves only to commit the spec.** The planner has no edit permission,
  so there is nothing else to save. A split or decline stops it without saving.
- **The task ends as split or declined at once**, while the planner is still stopping. The
  ended task waits for the stop, then removes the workspace and its branch. This way the
  ending is never held up by a slow stop.
- **Proposals are decided one by one.** Each approve or deny names the proposals it covers,
  by their position from 0. A decided proposal can't be decided again. Naming the same proposal
  twice in one decision is refused, since it is most likely a typo.
- **An empty proceed brief is refused.** The spec says the brief is always there.

**Stories this part reaches:** story 5, a split.

### Part 3: build

**Starting build.** The scheduler's start reaches a queued build task that isn't held.

- With no workspace, the task's workspace is requested, as in triage.
- With handed-over work waiting, main is merged next: `main.requested` and a merge main
  command in the workspace. This happens after a hold, when the merge couldn't go first.
- Otherwise the builder is requested. It gets the brief, the spec, the intent and rigor,
  what the last round handed back, and why it is back after a hold. It may edit unless the
  task is an `answer`.

**The table.**

| Step | Input | Result |
|---|---|---|
| queued | start | as above |
| creating workspace | workspace created | `workspace.created`, then the builder is requested |
| creating workspace | workspace failed | `workspace.failed`, then held as a failed workspace |
| starting | session started | `session.started`, the step is running |
| starting | session failed | `session.failed`, then held as a failed session |
| running | progress | `progress.reported`. Nothing else changes. |
| running | done | refused with an open question, or when the work doesn't fit the intent: a summary for `ship` and `try`, a report for `answer`. Otherwise `session.stopping` (reported) and `build.done` with the handed-over work. A stop that saves, except for `answer`. |
| stopping | session stopped | `session.ended`. With handed-over work: an `answer` moves to review with `phase.started`, using the handed-over commit and files. `ship` and `try` merge main. A failed save holds the task first (part 6). Held, the task waits with its handed-over work. |
| stopping | session ended | accepted, nothing happens |
| merging | main merged | `main.merged`. `ship` moves to review with `phase.started`, using the merged commit and files. `try` goes to approval or delivery (part 5). |
| merging | main conflict | `main.conflict`: the loop count goes up and the handed-over work is dropped. Under the cap, the builder is requested, told about the conflict. At the cap, held at the loop cap. |
| merging | main failed | `main.failed`, then held as a failed merge. The handed-over work is kept, so a retry merges again. |
| any | pause, resume, retry, kill, give up, a crash | part 6 |
| any | attach, detach | part 7 |
| any | ask, reply, deliver answer | part 8 |
| any | set | part 9 |
| any | start now, usage | part 10 |
| any | other replies | late |

**Decisions**

- **`phase.started` for review carries the handed-over work and the reviewed commit.** Review
  takes the plan and workspace from build. Everything else it needs is in the event, so
  replay never has to look back.
- **The reviewed commit includes what the stop saved.** The handed-over commit is fixed when
  the builder runs `done`. The stop that follows may commit leftovers. Merging main then
  merges the branch as it stands, and the merged commit is what review, approval and
  delivery all use. For `answer`, nothing is merged or saved, so the handed-over commit is
  the reviewed one.
- **An `answer` builder's stop doesn't save.** It had no edit permission, so there is
  nothing to commit.
- **`done` with work that doesn't fit the intent is refused.** A `ship` or `try` hands over a
  summary, and an `answer` hands over a report. Otherwise the delivery would have nothing
  to hand over.
- **A conflict at the loop cap holds the task.** The hold says the loops ran out, with
  "merging main conflicted" as the findings.
- **Progress changes no state.** It is kept in the log for you to read.

**Stories this part reaches:** story 7, a conflict.

### Part 4: review

**Starting review.** Review starts as soon as `phase.started` puts the task there, since it
keeps its slot. A queued review task that isn't held asks for what comes next:

- With no tester's copy, the copy is requested at the reviewed commit: `workspace.requested`
  and a create workspace command for a copy.
- With a copy, the tester is requested. It gets the brief, the spec, the intent and rigor,
  the reviewed commit and the handed-over summary or report. It can't edit.

**The table.**

| Step | Input | Result |
|---|---|---|
| queued | start | as above |
| creating workspace | workspace created | `workspace.created` gives the copy, then the tester is requested |
| creating workspace | workspace failed | `workspace.failed`, then held as a failed workspace |
| starting | session started | `session.started`, the step is running |
| starting | session failed | `session.failed`, then held as a failed session |
| running | pass | refused with an open question or no evidence. Otherwise `session.stopping` (reported) and `review.passed`. A stop that doesn't save. |
| running | changes | refused with an open question or no findings. Otherwise `session.stopping` (reported) and `review.changes_requested`. A stop that doesn't save. |
| stopping | session stopped | `session.ended`, then `workspace.removed` and a remove command for the copy. After a pass: approval or delivery (part 5). After changes: the loop count goes up, and `phase.started` moves the task back to build, with the findings for the next builder. Under the cap, the builder is requested. At the cap, the task is held at the loop cap with the findings. |
| stopping | session ended | accepted, nothing happens |
| any | pause, resume, retry, kill, give up, a crash | part 6 |
| any | attach, detach | part 7 |
| any | ask, reply, deliver answer | part 8 |
| any | set | part 9 |
| any | start now, usage | part 10 |
| any | other replies | late |

**Decisions**

- **The copy goes whenever the tester stops**, whatever the reason. A later tester gets a
  fresh copy at the same reviewed commit. Keeping an old copy would save a little time and
  add a state.
- **`phase.started` for build carries everything build needs**, wherever it comes from:
  the plan, the loop count, the workspace and what to hand back. Evolve never copies these
  from the phase before.
- **A pass needs evidence and changes need findings.** An empty one is refused, since the
  spec says the verdict comes with them.
- **At the cap, the task is held in build with the findings to hand back.** A retry then
  starts a builder with them, and the loop count stays where it is. The next request for
  changes holds the task again.
- **The loop count goes up when changes are requested**, as the build phase starts. A
  conflict also counts, as part 3 says. A denial doesn't.

**Stories this part reaches:** story 1 up to the pass, story 2's changes, and story 8.

### Part 5: approval and delivery

These are the last steps of review, or of build for `try`. Writing them down showed that the
types from part 1 didn't hold what they need. They now hold the output itself.

**Types**

- **The output is fixed when the task is ready to hand it over.** It names the exact commit
  to deliver. For `ship` it is the branch at the reviewed commit, mergeable, with the
  summary and the tester's evidence. For `try` it is the same, never mergeable and with no
  evidence. For `answer` it is the report at the reviewed commit, with the evidence.
- **Three last steps carry the output, and whether the changed files touch a critical path:**
  - **ready**: the output waits to be delivered. A task is here only while it is held,
    since otherwise delivery starts at once. This replaces part 1's "undelivered".
  - **awaiting approval**: the output waits for your sign-off.
  - **delivering**: the output is being handed over.
- **Build and review share these steps.** Part 1 gave build's versions the handed-over work
  and reviewed commit instead. The output holds what they were for.

**New event:** `output.ready` puts the output in the ready step. It is recorded when the
task first gets there, and when you clear an approval it no longer needs.

**Getting there.** After a pass, once the tester's copy is gone, or after a `try` merge:

1. `output.ready` with the output.
2. If the task has the approval flag, or its changed files touch a critical path:
   `approval.requested`.
3. Otherwise, unless the task is held: `output.requested` and a deliver output command.

The changed files are the reviewed commit's, which are everything the branch changed since
it left main. Each is matched against every `critical` glob in config.

**The table.**

| Step | Input | Result |
|---|---|---|
| awaiting approval | approve | `approval.given`, which makes the output ready. Then delivery, unless held. |
| awaiting approval | deny | refused with an empty note. Otherwise `approval.denied`, then `phase.started` for build with your note for the next builder. The task is queued, since awaiting approval held no slot. The loop count stays. |
| delivering | output delivered | `output.delivered`: the task ends as done. Then `workspace.removed` and a remove command that keeps the branch, unless the workspace is unsaved. An answer's proposals wait for your decisions. |
| delivering | output failed | `output.failed`: the output is ready again. Then held as a failed delivery. |
| any other step | approve, deny | refused: the task isn't waiting for your approval |
| ended | approve, deny | refused: the task has ended |
| ready | lifting the hold | delivery, see part 6 |
| any | set approval | part 9 |
| any | other replies | late |

**Decisions**

- **Delivery holds no slot.** No agent runs during it, as with awaiting approval.
- **A denial moves the task back to build even for `try`**, which was already in build.
  `phase.started` for build then starts build afresh, with your note.
- **The worktree is removed once delivery is confirmed, and the branch is kept.** The work
  lives on the branch or in the PR. The worktree would otherwise stay forever.
- **The critical paths are checked when the output is ready.** Config read then decides.
  A change to config later doesn't reopen a task already waiting.
- **The approval check uses the reviewed commit's files** for every intent, including
  `answer`, whose reviewed commit is the handed-over one.

**Stories this part reaches:** stories 1, 2 and 6 in full.

### Part 6: stopping an agent

This part covers everything that lets an agent go or holds a task: pause, resume, retry,
kill, a crash, giving up and a failed save. A stop always goes as "Stopping an agent" above
says. The next agent starts only once the stop is confirmed.

**Which stops save.** A builder on `ship` or `try` holds edits, so its stop saves. A builder
on `answer`, a planner and a tester never save. The planner's stop after proceed is the one
exception: it writes and commits the spec.

**The table.** "Stop" means `session.stopping` and a stop session command, which saves as
above.

| Input | Step | Result |
|---|---|---|
| pause | not held | `task.paused`. If running, the agent is stopped (stopped). Otherwise a request in flight finishes, and the task rests. |
| pause | held | refused: already paused, or held for another reason, which would be hidden |
| resume | paused | `task.resumed` (resume). The hold is lifted and kept as the hold last lifted. A ready output is delivered at once. A queued task waits for the scheduler. |
| resume | held for another reason | refused: retry it instead |
| resume | not held | refused |
| retry | held | `task.resumed` (retry), with the same effects as resume |
| retry | not held | refused |
| kill | any step | `task.killed`, or `task.failed` when the task is held at the loop cap. A running agent is stopped first. Workspaces nothing runs in are removed at once, keeping the branch, unless unsaved. The workspace an agent runs in, or is starting in, is removed once that agent's stop is saved. |
| give up | running | `task.held` (gave up, with the reason), then the agent is stopped (reported). Refused with an empty reason. |
| a crash | running, or starting that session | `task.held` (crashed, with the exit code and last line), then the agent is stopped (crashed), which saves its work. |
| a crash | stopping that session | accepted, nothing happens |
| session started | starting, held | `session.started`, then the agent is stopped (stopped) at once |

**An ended task still waiting on its agent**

| Input | Agent | Result |
|---|---|---|
| session started | starting | `session.started`, then the agent is stopped (stopped) |
| session failed | starting | `session.failed`. The workspace it was starting in is removed, unless unsaved. |
| a crash | starting | the agent is stopped (crashed) |
| a crash | stopping | accepted, nothing happens |
| session stopped | stopping | as in part 2: `session.ended`, then the removal |

**Decisions**

- **Pausing a held task is refused.** Turning a failure into a pause would hide it from the
  view of tasks waiting on you.
- **Resume lifts only a pause, and retry lifts any hold.** That follows the spec's two
  commands.
- **Kill at the loop cap ends the task as failed.** The spec says `task.failed` is "you gave
  up on it after a limit was reached". Every other kill ends it as killed.
- **A killed task keeps its branch**, so its work can still be found. Only a split or a
  decline deletes the branch.
- **A request in flight finishes during a pause.** A workspace or a merge can't be called
  back. When it answers, the task rests, held.
- **A crash before the start reply is still a crash.** The task waits on that start, so the
  session is its agent. The stop goes out at once, and the late start reply is then ignored,
  since the task already holds that session.
- **Kill doesn't stop a delivery in flight.** If it is confirmed after the kill, nothing more
  happens, and the log shows the task as killed. You see it in the output's own tool. This
  is a known gap: the log doesn't record a delivery confirmed after a kill.

- **Only a stop that saves says anything about saving.** Each stop records whether it
  saves. A "save failed" reply to a stop that doesn't save is ignored: it holds nothing,
  and marks no workspace unsaved. The property tests found why this matters. A tester runs
  in its own copy, so its stop's "nothing to save" once cleared the unsaved mark on the
  task's workspace, and that workspace was then removed. This changes part 2's table: a
  split's workspace is removed whatever its planner's stop reports.

**Stories this part reaches:** stories 3 and 9 in full, and story 8's kill.

### Part 7: attach and detach

You step into the agent's session and back out. While you are attached, the agent keeps
working with you, so the task keeps its slot (part 10), and the scheduler types no kept
answer into the session (part 8). Agent inputs are still heard as usual.

**The table.**

| Input | State | Result |
|---|---|---|
| attach | a running session, not attached | `session.attached` |
| attach | already attached | refused |
| attach | no running session | refused: there is nothing to attach to. This covers a held task, a task between agents and an ended task. |
| detach, resume | attached | `session.detached` (resume). The agent carries on. |
| detach, hand over | attached, in build, `ship` or `try` | `session.detached` (hand over), then as if the builder ran `done`: `session.stopping` (reported) and `build.done`, handed over by you, with the commit and files the daemon read from git. |
| detach, hand over | attached, in build, `answer` | refused: an answer needs the builder's report |
| detach, hand over | attached, in triage or review | refused: only a builder's work can be handed over |
| detach | not attached | refused |

**Decisions**

- **Attaching needs a running session.** Once the session has ended, or while it starts or
  stops, there is nothing to step into. `skel open` gives you the workspace instead.
- **An agent being let go takes your attachment with it.** A stop for any reason, a crash
  included, clears it. So a later detach is refused, which tells you the session had
  already gone.
- **Handing over takes your word for the summary.** The handed-over work is a summary that
  says you handed it over. The open question, if any, goes with the agent, as with any
  stop.
- **A refused detach leaves you attached in the core's view.** The CLI can then send a
  detach with resume.

**Stories this part reaches:** none of the nine. A new one: you attach to a builder, then
hand over, and the task merges main and goes to review.

### Part 8: questions

An agent asks and ends its turn. While the question is open, the task gives up its slot
(part 10). Your answer is kept until a slot is free. Then the scheduler's "deliver answer"
types it into the session, and the question closes.

**The table.**

| Input | State | Result |
|---|---|---|
| ask | the running agent, no open question | `question.asked`, with the session, text and options |
| ask | a question already open | refused: one question at a time |
| ask | empty text | refused |
| reply | an open question | `question.answered`, by you. A second reply before delivery replaces the first. |
| reply | no open question | refused |
| reply | empty text | refused |
| tracker reply | from an account config lists as yours | as reply, by that account |
| tracker reply | from any other account | refused: it doesn't count as yours |
| deliver answer | an answer kept, the asking session running, not held, not attached | `answer.delivered` and a type into session command with the answer |
| deliver answer | no answer kept | refused |
| deliver answer | you are attached | refused: you are in the session yourself |
| proceed, split, decline, done, pass, changes | the agent's own question open | refused: it waits for your answer first |
| progress, give up | the agent's own question open | accepted as usual. Giving up takes the question with the agent. |

The question also goes whenever its agent is let go, by any stop. That is rule 20.

**Decisions**

- **A second reply replaces the first while it waits.** You may change your mind before the
  answer reaches the agent. Once delivered, the question is closed, so a later reply is
  refused.
- **A kept answer isn't delivered while you are attached.** You are in the session, so you
  can say it yourself. The answer stays kept until you detach.
- **Options are passed through as given.** The core doesn't check that an answer is one of
  them, since you may answer something else.
- **The account check uses config, case for case.** "Me" and "me" are different accounts.

**Stories this part reaches:** story 4.

### Part 9: changing intent, rigor or approval

`skel set` is never refused for timing. `task.set` records the change at once. Its effect
comes at once when nothing is in flight. Otherwise it comes when the step in flight settles.
A set that names no field is refused. A set on an ended task is refused, as always.

**Stale work.** A builder's session and its handed-over work are made for one intent. Once
the intent changes, they are stale. In review, the handed-over work is stale once the task's
intent differs from the intent it was built for. A stale builder is stopped and replaced. Stale
work is never merged, reviewed or delivered. The task goes back to build, keeping its loop
count and its commits, and a fresh builder starts with the new permissions.

**During triage**, a change is kept as an override. Once both intent and rigor are set,
triage ends:

| Step | Result |
|---|---|
| queued | `phase.started` for build at once, with the title and description as brief. It waits for the scheduler. |
| creating workspace | once created, build starts and the builder is requested |
| starting | once started, the planner is stopped, then build starts |
| running | the planner is stopped (stopped), then build starts |
| stopping | once stopped, build starts. If the planner proceeded, your overrides win field by field. |

**During build and review, a change of intent:**

| Step | Result |
|---|---|
| queued | nothing more. The next start asks for a fresh builder. Stale handed-over work is dropped then. In review, any copy is removed and the task goes back to build. |
| creating workspace | build: nothing more. Review: once the copy is created, it is removed, and the task goes back to build. |
| starting | once started, the stale session is stopped and replaced |
| running | the stale session is stopped (stopped), then replaced. A tester's copy goes as usual. |
| stopping | once stopped, stale work goes back to build, whatever the agent reported |
| merging | once merged, stale work goes back to build instead of to review or delivery |
| awaiting approval, ready | `phase.started` for build at once. It waits for the scheduler. |
| delivering | once delivered, the task is done. Too late to change. If the delivery failed, the task goes back to build, still held as a failed delivery. |

**A change of rigor** changes only the field. A build or review under way carries on, and the
next review uses the new rigor.

**A change of approval:**

| Step | Result |
|---|---|
| ready, setting it | `approval.requested`: the task waits for your sign-off |
| awaiting approval, clearing it, with no critical file changed | `output.ready`, then delivery unless held |
| awaiting approval, clearing it, with a critical file changed | nothing more: the critical path still needs you |
| delivering | too late: the delivery carries on |
| any other step | the flag applies when the output is ready |

**Decisions**

- **"Waits until the step settles" means the reply handlers apply the change.** No change is
  stored apart from the field itself. Each reply compares the task's intent with the intent
  its session or work was made for.
- **A delivery in flight can't be called back.** The spec says set is never refused for
  timing, but a confirmed delivery ends the task. So a change during delivery takes effect
  only if the delivery fails.
- **A set to the same intent changes nothing.** Only a different intent makes work stale.
- **Going back to build from review drops the findings.** They were about work for the old
  intent.
- **During triage, approval alone is kept as an override**, and applies when build starts.

**Stories this part reaches:** none of the nine. A new one: you change a `ship` task to
`answer` while the builder runs. The builder stops, saving, and a fresh read-only builder
starts on the same branch.

**Found in review of part 8, and decided** (built with part 9)

- **Each question has a number, and a reply names the question it answers.** Questions are
  numbered 1, 2, 3 on each task, in the order asked. Without the number, a late tracker
  comment written for the first question could answer a second one from a new agent, which
  you never saw. A reply to a question that isn't open is refused. The CLI fills in the
  open question's number. A task source fills in the number of the question its comment
  replies to.
- **Detaching closes the agent's open question.** You were in its session, so you could
  answer it there. Without this, an agent you answered in person could never report,
  since its question stayed open. Any kept answer is dropped with it, since you were there
  to say it.
- **A kept answer is lost if its agent is let go first.** Rule 20 requires this. The log
  still shows `question.answered` with no `answer.delivered` after it, so you can see it.
