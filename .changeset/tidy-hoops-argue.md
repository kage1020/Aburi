---
"@aburi/lang-typescript": minor
"@aburi/effects-prisma": minor
"@aburi/effects-trpc": minor
"@aburi/types": minor
---

Read a bracket access in a callee as the property it addresses

`prisma["user"].create({ data })` was reported as a call to `prisma.create`. The walk read the
object of a `subscript_expression` and dropped the index, so the target named a call that is
nowhere in the program — spelled exactly like an ordinary two-segment method call, and one
segment short of the `<client>.<model>.<verb>` shape `@aburi/effects-prisma` matches. The
`db.write` was lost with it, and nothing in the report said a write had gone missing.

**A string-literal index is the segment it spells.** `prisma["user"].create(…)` and
`prisma.user.create(…)` address one property and now produce one target, `prisma.user.create`,
with no `dynamicReceiver` — the receiver is a name, written with brackets. The literal is
decoded rather than unquoted, a template that substitutes nothing counts as one, and an index
the parser guessed at is refused whether the ERROR stands inside the literal (`obj["a\u12b"]`)
or beside it (`prisma["user" "audit"]`, a missing operator). Where the brackets sit does not
matter: `prisma.user["create"]()` folds the same way.

**An index that names no segment is reported as one that names none.** An identifier
(`prisma[model]`), a number (`items[0]`), a substituting template, a string the qualified-name
grammar has no segment for (`obj["a-b"]`, `obj["a.b"]`, `""`): the bracket contributes the
reserved segment `<computed>` — `prisma.<computed>.create` — and the call carries
`dynamicReceiver`. `<` is outside that grammar, so a target carrying the segment matches no
Symbol id and no Symbol name; it resolves against nothing rather than against whatever the
shortened name happened to find.

**The sentinel is a name to no consumer.** A plugin that reads a fixed position of a target now
meets a segment that names nothing where it expected a name, and segment *count* is what several
of them match on:

- `@aburi/effects-prisma` credits a computed model only where the receiver names a client
  binding. `prisma[model].create(…)` is a `db.write` at `medium`, as the issue asks; `queues[id].upsert(job)`
  and `sets[key].delete(item)` stay unclassified, which is the answer `queue.upsert(job)` already got.
- `@aburi/effects-trpc` now reads `dynamicReceiver` at all, and records such a call at `medium`
  rather than `high`. `handlers[key].query()` reaches a proxy call's segment count with none of
  its evidence, and the plugin asserted certainty on every shape it matched.
- `@aburi/types` exports `COMPUTED_TARGET_SEGMENT`, so a producer and a consumer spell the
  segment from one place rather than by hand. The IR schema records it in `Call.target` and
  `Effect.target` descriptions.

**What a reader will meet after upgrading.**

- A call target may carry a segment the source writes in brackets, and `items[0].save()` reads
  as `items.<computed>.save` where it read as `items.save`.
- The logic fingerprint reads `effects[].target`, so the first diff across the upgrade reports
  logic changes on symbols whose source did not change.
- A call an effect plugin claims is in no call-resolution bucket — a classified call never
  reaches `calls[]` — so for `prisma[model].create()` the record of the computed model is
  `effects[].target` plus the `medium` tier, not `stats.callResolution.unresolved.dynamic`.
- `@aburi/effects-nest` matches an emitter name at a fixed position, so `this.emitter[i].emit(e)`
  stops being an `event.publish` where it was one. The name is still spelled in the target, one
  segment further back; reading through the sentinel is a change to that plugin's own rule and
  is left to it.
- A configured `suppress` / `keep` prefix matches on exact-or-dot-prefix, so
  `suppress: ["metrics.increment"]` stops matching `metrics["http"].increment(n)`, which is now
  `metrics.http.increment`. Nothing warns about a prefix that matches nothing.
- `process["exit"]()` is recognized as an early exit, so an `if` that ends in one is a guard.
