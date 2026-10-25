---
"@aburi/markdown-projection": minor
---

The Slice View draws each Slice as the calls that join it, says in words what happened to each member, and marks only the unresolved calls that could have joined two Slices.

A Slice was a heading made of its id, ``### `slice:ts:src/ctl.ts#Ctl.route` (3 members)``, over its members in id order, three lines each, with a `---` after it. It now reads from the members nothing else in it calls, each member on one row with its callees indented under it in the order it calls them:

```md
### From `Ctl.route` (3 symbols)

Files: `src/ctl.ts`, `src/repo.ts`, `src/svc.ts`

- `Ctl.route` — logic changed · `ctl.ts:42`
  - `Svc.op` — logic changed · `svc.ts:88`
    - `Repo.save` — new method with db.write · `repo.ts:15`
```

The `Files` line gives each path once, and a row writes a file by the fewest trailing segments that tell it apart from the others in the Slice. A member reached a second time reads *(see above)*, and a chain deeper than five levels carries on from a `*(continued)*` row.

A member's wording reads `API and logic changed`, `syntax only` or `moved: <route>; logic changed` where it listed `delta.apiChanged, delta.logicChanged, delta.syntaxChanged`, and an added or removed member names its kind and its effects, `new method with db.write`, where it read `new symbol`. A member whose dropped flag flipped reads `now dropped` or `no longer dropped`. The status in italics is gone, since the wording says it.

The ⚠ marker counted every call with `resolved: null`, so a call to `join`, `push` or a library function marked the member: on Aburi's own pull requests three members in four carried one, and of the 2,719 calls counted, 76 named a changed symbol at all. A member is now marked only for an unresolved call that could be a call to a member of another Slice: one ending in that member's name and written the way it is called, a bare call for a plain function, a call through a receiver for a method whose class the receiver names. The marker names the target, ``⚠ unresolved call to `getRepo.save` ``, where it gave a count, and the note under the heading counts those calls and says the Slices they connect may belong together.

The Standalone changes fold writes each singleton on one row, ``- `formatMoney` — syntax only · `src/util.ts:3` ``, where it wrote the singleton's Slice id beside the name, and its summary reads `1 symbol with no resolved call to or from another changed symbol` where it read `1 singleton slices (no in-Node call-graph neighbours)`.
