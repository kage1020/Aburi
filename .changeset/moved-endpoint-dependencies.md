---
"@aburi/diff": minor
---

A call edge whose caller or callee only moved to another file is no longer reported as one removed and one added dependency. `diffDependencies` keys a base edge under the head ids the Symbol pairing gave its endpoints (a `moved`, `moved+changed`, `changed` or `dropped-toggled` entry's `after` id), as Slice View already does for base call edges, so the same call between the same two Symbols compares as unchanged and `summary.depsAdded` / `depsRemoved` count only calls that appeared or went. A removed edge is still reported under the ids the base wrote. `diffDependencies` takes the mapping as an optional fourth argument; without it, edges compare by the ids each document wrote, as before.
