---
name: reviewing-code
description: Find real bugs in code by checking it against its spec and invariants, and proving each finding with a failing test. Use after a few slices of new code, before calling a part done, or when asked to review.
---

# Reviewing code

A review finds bugs, not style. A finding counts only when a failing test proves it.

## Get fresh eyes

The person who wrote the code reads what they meant, not what is there. Where you can,
hand the review to a subagent that hasn't seen the work. Give it the spec, the invariants,
the code and this skill, and none of your reasoning. It reports findings and never edits a
file.

## Steps

1. **Spec to code.** Go through the spec for this part rule by rule. For each rule, find
   the code that enforces it and the test that checks it. A rule with no code is a bug. A
   rule with no test is a gap.

2. **Code to spec.** Go through the code branch by branch. Every branch that refuses,
   accepts or changes state should trace back to a line in the spec or a recorded
   decision. A branch with neither is either a bug or an unrecorded decision.

3. **Attack each invariant.** For each invariant, try to build an input sequence that
   breaks it. Try the awkward inputs first: a reply that arrives late, twice or out of
   order, an input from the wrong sender, an input after the end, and two things happening
   to the same task in a row.

4. **Test the tests.** For a few important tests, change the code they cover so it is
   wrong, and run them. A test that still passes checks nothing. Undo the change afterwards.

5. **Check the code rules** in `AGENTS.md`, such as purity, no casts and errors as values.

6. **Check the spec too.** A mistake in the spec, built faithfully, is still a bug. Record
   it as a decision with the fix you chose.

## Each finding

Sort it. **Critical** is wrong behaviour or a broken invariant. **Important** is a real
problem that should be fixed. **Minor** goes in the report only. A style you would have
written differently is not a finding.

- Write it as a failing test first. If you can't make it fail, it isn't a finding yet.
  Drop it, or note it as unproven.
- Say the consequence in one sentence, such as "work can ship without review".
- Fix each Critical and Important finding test first, like any other slice, and commit the
  test with the fix. Then review again, the fixes only.
- Stop after three rounds. Report what is still open rather than going round again.

## Report

List what you checked, what you found, and what you fixed. Say what you didn't get to.

Then move on to the next part, starting again with the `writing-specs` skill.
