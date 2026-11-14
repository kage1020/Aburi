---
"@aburi/core": minor
---

Resolve a call through a field of a declared type without LSP. `this.repo.find(id)` beside `constructor(private readonly repo: UserRepository)` now reaches `UserRepository.find`, at `medium` confidence because the value can be a subclass's, where it used to stay unresolved in the `dynamic` bucket. The type is read from the language plugin's `receiverType` and bound as the file's own names are, by its declarations and its imports; it must name a class that declares the member itself, as an instance member. An interface-typed, unannotated, union-typed or inherited field still resolves nothing, and an LSP hint for the call, when there is one, still decides it.

On the pinned benchmark repositories this resolves 375 more calls on `nest` (3,243 → 3,618), 149 on `cal-com`, 55 on `tanstack-query`, 13 on `trpc` and 5 on `hono`, each leaving the `dynamic` bucket; the others are unchanged. `resolveCallGraph` takes the types as `receiverTypes`, keyed by the calling Symbol, the line and the target.
