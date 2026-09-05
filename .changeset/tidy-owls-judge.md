---
"@aburi/effects-prisma": minor
"@aburi/effects-drizzle": minor
"@aburi/plugin-registry": minor
"@aburi/lang-typescript": patch
---

Weigh the receiver before attributing a database effect to a call

`delete`, `create`, `update` and `select` are shared vocabulary — `Map`, `Set`, the DOM,
RxJS stores and every HTTP router spell their verbs the same way an ORM does. Both
classifiers matched on that vocabulary plus a file-level import gate, and the gate answers
"does this file use the library", which a file is free to answer yes to while most of its
calls belong to something else. So a repository holding a `Map` cache beside its Prisma
client recorded `this.cache.items.delete(key)` as a `db.write` at `high` — the tier a
hand-annotated effect gets — and an Express router beside its Drizzle queries did the same
for `router.delete("/users/:id", handler)`.

Three checks now stand between the shape and the record. A first argument the library could
never take rules the call out entirely: no Prisma method and no Drizzle root takes a bare
literal, so a route registration is not classified at all. Then the receiver sets the tier
rather than being assumed — the segment holding the client is matched word-wise against
each plugin's vocabulary of client binding names, so `prismaClient`, `readReplicaDb` and
`_db` land at `high` while `cache`, `router`, `store` and `apiClient` do not. And the
argument count is weighed against what the method actually takes, which is one for most of
them and two for `$transaction`, Postgres' `selectDistinctOn(columns, projection)` and
Drizzle's `transaction(callback, config)`.

Anything short of all three downgrades to `medium`, it does not drop the effect. Effect
plugins never see the AST, so a client bound under a house naming convention and an
unrelated object of the same shape are not separable from the callee string — dropping the
first would be as wrong as claiming the second at `high`. The same reasoning governs the
argument count: it is a syntactic count, and a classifier is the first thing to read it as
a signature, so a miscount costs the tier rather than erasing a write and logging nothing.

`@aburi/lang-typescript` stops counting comments as arguments. They are grammar `extras`,
so tree-sitter hangs them inside the argument list: `db.delete(\n  users, // soft delete
is not used\n)` reported two arguments, and a leading comment took `literalArgs[0]` from
the argument it belongs to. Both fields now match the source's arguments in count and in
order.

`@aburi/plugin-registry/plugin-input` gains the readers both plugins share:
`identifierWords` / `identifierMentions` (a word split, so `feedback` does not read as
`db`) and `hasLiteralFirstArgument`. `effect-plugin.md` §5.4 carries the rule for the next
effect plugin whose verbs are someone else's too.

**What the first scan after this shows.** `confidence` is part of effect identity in the
diff (`effectsEqual`) and propagates along call-graph edges as a floor, so every effect
that moves from `high` to `medium` reports as `modified` — plus the ancestors that inherit
it — against source that did not change. That is the reclassification landing, not a
regression.
