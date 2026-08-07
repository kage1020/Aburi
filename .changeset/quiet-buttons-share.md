---
"@aburi/core": patch
"@aburi/cli": patch
---

Make Unicode normalization total across every comparison the IR makes

Ids and paths were normalized to Unicode NFC at the points where they enter the process, so
the string held in memory and the string written to disk are one string. Several values that
decide an order or an identity were not, and the missing halves were quiet.

`effects[].target` is the clearest. `propagateEffects` orders propagated entries by
`(id, target)`, integrity invariant #11 verifies that order against the in-memory value, and
`serializeCanonical` writes the normalized one — so a Document could satisfy the sort
invariant and land on disk violating it. The two spellings of `é` sort on opposite sides of
`z`, so this is an inversion, not a near-miss.

The rest are comparisons where one side is normalized and the other is not. That is worse
than neither being normalized, because it turns a match into a miss:

- `signature.inputs[].name` is compared against a call's head segment to decide that a
  parameter shadows a Symbol of the same name. A miss emits an edge to an unrelated Symbol,
  which then carries effects through propagation.
- `ImportEdge.namespaceBinding` / `symbols[]` / `source` decide import-scope resolution. A
  miss puts the call in the `no-match` diagnostic bucket instead of `external` — the state
  that sends a reviewer looking for a typo that does not exist.
- The `suppress` / `keep` / `dropCallees` prefixes decide whether a call is dropped. A miss
  leaves nothing in the Document to trace it back from.
- `components[].publicApi` is deduped and sorted at collection and compared across revisions
  by `@aburi/diff`, whose base side came off disk normalized. A mismatch reports a
  `publicApiChanged` for a component nobody touched.

All of them are now normalized where they enter: the scan pipeline's plugin boundary,
`buildDropCFilter`, `normalizePackagePath`, and the CLI's config-component path.

**The rule now has one home.** `ir-schema.md` §1.2 states it — every string in a Document is
NFC, why that is load-bearing for both ordering and identity, the entry points where it is
established, and why it is NFC and not NFKC (compatibility folding rewrites text rather than
respelling it, collapsing distinct ids and misquoting source). The explanation had been
repeated across `canonical.ts`, `id.ts`, `workspace.ts` and their tests; those now reference
the section. §1 no longer says "alphabetical" and "UTF-16 code unit" in the same breath, and
§9.4 states the propagated-effect ordering that made `target` a sort key in the first place.

**Invariant #19** makes it checkable on a Document read off disk: `source.file`,
`effects[].target`, `calls[].target`, `components[].roots`, `components[].publicApi`,
`workspace.managers[].roots` and both `dependencies[]` endpoints. Ids and `Symbol.name` are
left to #17 — all three grammars are ASCII-only, so a non-NFC value fails the grammar first
and reporting it twice would have the reader chase one string twice. Strings the Document
quotes are excluded for the opposite reason: their spelling decides nothing, and normalizing
a quotation would misquote it.

Normalization violations now name both spellings by code point. They render identically by
definition, so the old message showed a string that looked correct beside the claim that it
was not. The Symbol id constructor's version of the same message was fixed with it.
