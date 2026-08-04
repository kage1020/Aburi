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

`makeSymbolId` normalizes its parts for the same reason. Filesystems disagree on which
spelling they return — macOS decomposes, Linux and Windows do not — so the same source
tree produced different Symbol ids depending on where it was scanned, and every
cross-platform diff reported spurious changes. It also keeps the id in memory and the id
on disk the same string: integrity invariant #11 compares the in-memory form, so an
un-normalized id could pass the sort check and still land on disk out of order.
