---
"@aburi/lang-typescript": patch
---

Read the parameter of a parenthesis-free arrow

`export const greet = name => "hi"` was extracted as a zero-arity function. The signature
reader looked for a `parameters` field or a `formal_parameters` child, and an arrow written
without parentheses has neither: the grammar hangs its single binding off a `parameter` field
as a bare identifier. The parenthesised spelling of the same function, `(name) => "hi"`, was
read correctly, so the two ways of writing one parameter disagreed.

`inputs` is compared positionally by the api fingerprint, so both directions of that
disagreement produced a wrong report:

- **Dropping the parameter was no change at all.** `name => "hi"` → `() => "hi"` left both
  revisions reading zero-arity with the body untouched, so the Symbol was `unchanged` and
  every caller still passing an argument was told nothing.
- **Adding parentheses was an api change.** `x => x + 1` → `(x) => x + 1` moved `inputs` from
  `[]` to one entry and reported `apiChanged` on a function whose contract nobody touched.

Both now report what the source did. The parameter is read from the `parameter` field and
emitted untyped — `{ name: "x", type: "" }` — which is exactly what `(x) => …` already
produced, so the two spellings are one signature. Nothing else about the form changes: `async
x => …` still sets `async`, and `() => 1` still reports no inputs.

Anything downstream of the signature moves with it — the api fingerprint, `signature.inputs`
in the diff delta, and the `signatureSimilarity` term that matches a renamed function. A
report over sources that use the parenthesis-free form may show api changes on the first run
after upgrading that the previous version did not surface, and lose ones it surfaced for the
added parentheses.
