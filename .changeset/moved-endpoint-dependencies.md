---
"@aburi/diff": minor
---

A call edge whose caller or callee was paired under a new id — moved to another file, renamed in its file, or either with its body changed — is no longer reported as one removed and one added dependency. `diffDependencies` keys a base edge under the head ids the Symbol pairing gave its endpoints (a `moved`, `moved+changed`, `changed` or `dropped-toggled` entry's `after` id), as Slice View already does for base call edges, so the same call between the same two Symbols compares as unchanged. `summary.depsAdded` / `depsRemoved` count only calls that appeared or went, and `depsUnknown` can fall too: an edge through a moved Symbol whose old file the head skipped, until now one `unknown` and one `added`, is no change when the head holds the call under the new id. A removed or unknown edge is still reported under the ids the base wrote.

`diffDependencies` now requires the mapping as its fourth argument: each paired change's `before.id` to its `after.id`. An empty map compares edges by the ids each document wrote, as before. Two base edges that read as one key under the mapping, which a Document the integrity checker accepts cannot hold, raise `DiffError` with code `ir-identity-collision` instead of one of them dropping out of the diff.
