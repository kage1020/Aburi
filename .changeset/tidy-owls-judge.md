---
"@aburi/effects-prisma": minor
"@aburi/effects-drizzle": minor
"@aburi/plugin-registry": minor
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

Two checks now stand between the shape and the record. The library's own signatures rule
out what it could not have produced: no Prisma delegate method and no Drizzle
query-builder root takes a bare literal or a second argument, so a route registration is
not classified at all. Then the receiver sets the tier rather than being assumed — the
segment holding the client is matched word-wise against each plugin's vocabulary of client
binding names (`prisma` / `db` / `drizzle` / `client` / `tx` / …), so `prismaClient`,
`readReplicaDb` and `_db` still land at `high` while `cache`, `router` and `store` do not.

An unrecognized receiver downgrades to `medium`, it does not drop the effect. Effect
plugins never see the AST, so a client bound under a house naming convention and an
unrelated object of the same shape are not separable from the callee string — dropping the
first would be as wrong as claiming the second at `high`, and the uncertainty belongs in
`confidence` rather than in a guess. A receiver the language plugin already flagged as
dynamic (`getDb().select()`) is capped at `medium` for the same reason: the name in the
target is a collapsed expression, not a binding.

`@aburi/plugin-registry/plugin-input` gains the readers both plugins share:
`identifierWords` / `identifierMentions` (a word split, so `feedback` does not read as
`db`) and `hasLiteralFirstArgument`. `effect-plugin.md` §5.4 carries the rule for the next
effect plugin whose verbs are someone else's too.
