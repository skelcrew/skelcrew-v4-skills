---
name: writing-code
description: Build behaviour in small, tested slices against a spec. Use whenever you write or change code that does something, from a single transition to a whole part.
---

# Writing code

Build one slice at a time. A slice is one behaviour you can name in a sentence, such as
"a done report during review is refused". Each slice ends green and committed.

## Before the first slice

- Make sure the spec answers what you are about to build. If it doesn't, use the
  `writing-specs` skill first.
- List the slices in order, so each builds on the last. Start with the happy path through
  the whole flow, then add the awkward cases.

## Each slice

1. **Name the behaviour.** One sentence, taken from the spec. Find the line it comes from.

2. **Write the test from the spec, not from the code.** It checks what a caller sees. If
   you can't write the test without knowing the code, the slice is too big or the spec is
   unclear.

3. **Run it and watch it fail.** It must fail because the behaviour is missing. A failing
   import or a broken fixture is not red. Fix the test and run it again.

4. **Write the smallest code that passes.** Don't build ahead for the next slice.

5. **Tidy while green.** Remove repetition, rename for clarity, and make the main function
   read as an outline. Delete scaffolding: placeholder defaults, branches that can't run,
   and helpers that only exist to satisfy the type checker. Where a reader would ask why,
   say why in a comment. Run the tests after each change.

6. **Ask what else this cell could see.** For the state and input you just handled: what
   if the input comes twice, late, out of order, from the wrong sender, or after the end?
   Each answer the spec gives is another slice. Each answer it doesn't give is a decision
   to record.

7. **Run the full check and commit.** The commit says what the behaviour is and why.

## Every few slices

- **Add a property test for each invariant** as soon as enough exists to reach it. Feed
  random input sequences and check the invariant after every step. Steer most random
  inputs toward ones the current state accepts, or the runs never get past the start.
- **Re-read the spec for this part.** Tick off what is built and find what isn't.

## When the part is built

Use the `reviewing-code` skill on it before you start the next part.
