---
"@aburi/core": patch
---

Normalize Unicode before ordering, so canonical output is canonical

`serializeCanonical` sorted object keys in whatever Unicode form the caller held and then
wrote them normalized, which broke the property the function exists to provide:

- two objects whose keys differed only in composition (`é` as one code point versus `e`
  plus a combining acute) produced different bytes, and therefore different fingerprints,
  for the same logical value;
- keys that were distinct strings but identical once normalized were both written,
  producing JSON a parser silently collapses — an entry lost on the next read;
- the emitted key order did not match the emitted bytes.

Keys are now normalized first and ordered afterwards, and a post-normalization collision
is rejected with a `CoreError` rather than written, matching how the serializer already
treats other lossy coercions.

Paths are normalized where they enter the process, in `toPosixRelative`. Which Unicode
spelling a path arrives in depends on how the name was created — an archive, an HFS+
volume, a Finder rename — and it survives copying to any platform, so one source tree could
produce two spellings for a file and every cross-platform diff reported spurious changes.
Normalizing at that single point keeps `symbol.source.file`, `components[].roots` and the
Symbol id built from the same string spelled identically; normalizing inside the id
constructor alone would have left them disagreeing, which silently degrades a rename into
a delete-plus-add in `@aburi/diff`.

`makeSymbolId` and `trySymbolId` normalize their parts too, before validating rather than
after, so the ids `isSymbolId` accepts are exactly the ids the constructors can mint. That
also keeps the id in memory and the id on disk the same string: the integrity sort check
compares the in-memory form, so an un-normalized id could pass it and still land on disk
out of order.

`serializeCanonical`'s new refusal has its own error code, `canonical-key-collision`.
Reusing `non-plain-json` would have been wrong — each key is perfectly representable, and
it is their coexistence that is not.
