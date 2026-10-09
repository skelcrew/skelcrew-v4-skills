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
- **An ended task can still owe one cleanup.** When a task ends while its agent is stopping,
  it keeps that session and the workspace the agent ran in. Once the stop is confirmed and
  saved, the workspace is removed. If the save failed, the workspace is kept for good.

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
- **A crash is recorded as a hold, not as `session.ended`.** A crashed session's pane stays
  open, so it still needs a stop, and its uncommitted work still needs saving. The task is
  held as crashed, and the stop goes out. The stop's reply then records `session.ended` as
  stopped. So `session.ended` never carries the reasons `crashed` or `reported`. Every
  report is followed by a stop, so `reported` would never be the reason either.

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
6. An agent's input is heard only from the session the task's step holds as running, and
   only for the role that fits the phase. Everything else is refused.
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
