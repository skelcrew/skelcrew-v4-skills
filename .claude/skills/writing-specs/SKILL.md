---
name: writing-specs
description: Turn a design into something code can be written against, before writing the code. Use when starting a new part, when the code needs types, events, states or invariants that the docs don't pin down yet, or when you find the spec silent or unclear on a case.
---

# Writing specs

A spec is ready when every question the code will ask has an answer written down. The
work is finding the questions the design forgot.

## Steps

1. **Read what exists.** Read the design docs for this part end to end. Note every term,
   state and rule they use.

2. **Write the types first.** Write down the states, the inputs, the events and the
   commands. Each state holds only the fields it needs. If two states share a field, ask
   whether the field means the same thing in both.

3. **Fill the table.** For every state, go through every input. Write what happens:
   - accepted: which events it records and which commands it sends, or
   - refused: the reason, in plain words.

   No cell stays empty. "Can't happen" is an answer only with the reason it can't. Pay
   most attention to the awkward cells: a reply that arrives late, twice or out of order,
   an input from the wrong sender, and an input after the work has ended.

4. **Write the invariants as checks.** Each one is a rule you can test against any state
   or any run, such as "a task never holds two sessions". If you can't say how a test would
   check it, it is a wish, not an invariant.

5. **Write a few stories.** A story is a whole lifecycle as a list of inputs, with what
   should come out. Include at least one that goes wrong and recovers.

6. **Record every call you made.** Where the design was silent and you chose, write the
   choice and the reason under a "Decisions" heading. Never fold a guess quietly into the
   spec.

## Check before you finish

- Every term is defined the first time it appears.
- No two parts contradict each other. Read them against each other, such as "before the
  claim" in one place and "after the claim" in another.
- Every table cell is filled.
- Every invariant names how it is tested.
- Someone who wasn't there could write the code from this without asking you.

Then build it with the `writing-code` skill.
