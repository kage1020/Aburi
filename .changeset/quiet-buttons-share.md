---
"@aburi/core": patch
---

Normalize the two remaining strings the IR orders by, and state the rule in one place

Ids and paths were normalized to Unicode NFC at the points where they enter the process, so
the string held in memory and the string written to disk are one string. `Symbol.name` and
the call target were not, and both decide something.

`effects[].target` is the clearer failure. `propagateEffects` orders propagated entries by
`(id, target)`, integrity invariant #11 verifies that order against the in-memory value, and
`serializeCanonical` writes the normalized one — so a Document could satisfy the sort
invariant and land on disk violating it, and two spellings of one table name could be
carried as two entries. `Symbol.name` is the same class of problem one field over: it is
what the api fingerprint reduces to a short name and what the diff matcher compares between
revisions.

A language plugin reads identifiers out of source bytes, so whichever spelling a file
carries is the spelling it returns. Both are now normalized at the scan pipeline's plugin
boundary — before the drop filter and before any effect classifier sees the call, so one
spelling reaches every consumer and the value recorded against a plugin's answer is the
value that plugin was given. The candidate and the call are returned unchanged when nothing
differs, so an ASCII scan allocates nothing extra.

**The rule now has one home.** `ir-schema.md` §1.2 states it: every string in a Document is
NFC, why that is load-bearing for both ordering and identity, and the four entry points
where it is established. The explanation had been repeated across `canonical.ts`, `id.ts`,
`workspace.ts` and their tests; those now reference the section instead of restating it.

**Invariant #19** makes it checkable on a Document read off disk: `symbols[].name`,
`symbols[].source.file`, `symbols[].effects[].target`, `symbols[].calls[].target`,
`components[].roots[]` and `workspace.managers[].roots[]` must be NFC. Ids are left to #17,
whose grammar already refuses a non-NFC part, so one defect is reported once. Strings the
Document merely quotes — a decorator's raw source text, a signature type — are deliberately
out of scope: their spelling decides nothing, and normalizing a quotation would misquote it.
They still reach disk normalized, because the serializer normalizes everything.
