---
"@aburi/diff": minor
"@aburi/core": minor
---

Name the field a diffed IR is missing, instead of crashing on it

`buildDiff` is public API and ran no integrity check, so an IR a caller assembled in memory
reached the matcher unverified. Seven fields it reads crashed it with a bare `TypeError` that
named neither the collection nor the index — measured, one field deleted at a time from a
well-formed pair: `symbols[].fingerprint`, `.source`, `.calls`, `.decorators`, `.effects`,
`.rules`, and `components[].roots`.

`buildDiff` now runs `checkDocumentShape` on each side before the identity pass. The refusal
is a `DiffError` with code `ir-shape-invalid`, naming the side, the collection, the index and
the field: `headIR.symbols[3]: "fingerprint" is absent, not an object.` More than one breach
is reported in one throw, with the rest counted, so a malformed IR is not fixed one run at a
time.

**Invariant #20, and only #20.** The other nineteen are statements about a Document whose
answer the diff does not depend on — an unsorted `symbols[]` diffs correctly, because stage 1
keys by id — so running them would withhold an answer the matcher can give, and `aburi diff`
would re-pay all twenty on a Document `readIR` already checked. It re-pays the structural walk
instead: 1.8ms per side at 1,000 Symbols, 17ms at 10,000.

**This refuses IRs that used to produce an answer.** A Symbol missing `visibility`, `name` or
`kind` was diffed happily, because nothing in the matcher dereferenced it. The gate is scoped
to what the `IR` brand asserts rather than to what today's matcher touches: a scope that moved
with the matcher would leave a caller's Document conditionally valid, and `integrity-shape.ts`
makes that argument for itself while naming this consumer.

`checkDocumentShape` is now exported from `@aburi/core`. It was module-exported only, and
`checkIRIntegrity` — which runs it and then the other nineteen — was the sole way to reach it.

The messages are the ones `checkDocumentShape` writes, subject naming the record and message
naming the field, rather than a second wording for the same breach. Callers matching on
`DiffError.message` for a malformed Document see the new form; `code` is unchanged.
