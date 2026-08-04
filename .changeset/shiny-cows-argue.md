---
"@aburi/markdown-projection": patch
---

Render the `modified` bucket of every `SymbolDelta` array

`ArrayDelta` has three buckets and `@aburi/diff` fills all three — `differentiate` routes
an element whose identity key matched but whose content changed into `modified` — while
the projection read it in exactly one place, for decorators. Everything else was dropped:

- a rewritten guard condition (`rules.modified`),
- an effect whose confidence was downgraded (`effects.modified`),
- a call that stopped resolving (`calls.modified`),
- and, because `signature.inputs` keys on `${index}:${name}`, every parameter whose type
  changed — the most common breaking API change in TypeScript.

Those symbols rendered as a heading and a file link with no body, so the CI gate fired on
a change whose explanation was blank.

`signature.inputs` added / removed now name the parameter and its type instead of
reporting a count, and a delta that renders nothing while claiming an API or logic change
says so in one line rather than leaving the section empty.
