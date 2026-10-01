---
"@aburi/diff": patch
"@aburi/core": minor
---

A deleted function is no longer reported as moved into an unrelated Symbol

A logic fingerprint that names nothing (no effect, and no rule carrying a condition, a thrown
value or an expression) is shared by unrelated bodies: one value for every class, enum and body
that only calls something, another for every body that is one `for` loop over calls. Stage 3
paired a lone base in such a group with whichever head was closest by name, with no similarity
floor and no kind check. A deleted function and an unrelated class or function added anywhere
became one `moved+changed`, so `summary.removed` stayed 0 and `--fail-on removed` passed.

Stage 3 now groups by kind as well as logic fingerprint, and a group whose logic names nothing
has no lone-candidate shortcut: a pair in it needs a name similarity of 0.85 and a name of more
than one word on both sides. `@aburi/core` exports `logicNamesNothing`, which reads that off the
fingerprint's own input.

What stops pairing, without git rename information:

- A move of such a Symbol whose name changed, or says one word. `class Invoice` that moved file,
  `InvoiceRenderer` renamed to `InvoicePrinter` and `DEFAULT_TIMEOUT` renamed to
  `REQUEST_TIMEOUT` are each added + removed: stage 4 does not read a Symbol without a
  signature. `Cls.getUser` renamed to `Cls.fetchUser` with a body that only calls something is
  refused by stage 4 as well.
- A Symbol whose kind changes as it moves file, whatever its logic: a method extracted into a
  function in another file, or an `enum` rewritten as a `const` there.
- An owner and its members are paired independently, so `class Invoice { render() }` that moved
  file reports the class as added + removed and the method as moved.

Such a pair is labelled `logic-fingerprint+name-disambiguation` even when it had one candidate.
It was a name floor rather than a choice between names, but a new `MatchRationale` value would
be a breaking change to `aburi.diff.v1`.
