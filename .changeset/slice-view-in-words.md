---
"@aburi/markdown-projection": patch
---

The Slice View says in words what happened to each member, and marks only the unresolved calls that could have joined two Slices.

A member's `↳` line reads `API and logic changed`, `syntax only` or `moved: <route>; logic changed` where it listed `delta.apiChanged, delta.logicChanged, delta.syntaxChanged`, and an added or removed member names its kind and its effects, `new method with db.write`, where it read `new symbol`. A member whose dropped flag flipped reads `now dropped` or `no longer dropped`.

The ⚠ marker counted every call with `resolved: null`, so a call to `join`, `push` or a library function marked the member: on Aburi's own pull requests three members in four carried one, and of the 2,719 calls counted, 76 named a changed symbol at all. A member is now marked only for an unresolved call whose target ends in the name of a member of another Slice, and the marker names the target, ``⚠ unresolved call to `getRepo.save` ``, where it gave a count. The note under the heading counts those calls and says the Slices they connect may belong together.

The Standalone changes fold writes each singleton on one line with its file and follow-up, ``- `formatMoney` — *(changed)* · `src/util.ts:3` · syntax only``, where it wrote the singleton's Slice id beside the name, and its summary reads `1 symbol with no resolved call to or from another changed symbol` where it read `1 singleton slices (no in-Node call-graph neighbours)`.
