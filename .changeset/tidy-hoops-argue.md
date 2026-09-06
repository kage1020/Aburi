---
"@aburi/lang-typescript": minor
"@aburi/types": patch
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
decoded rather than unquoted (`prisma["user"]` is `prisma.user`), and a template that
substitutes nothing counts as one.

**An index that names no segment is reported as one that names none.** An identifier
(`prisma[model]`), a number (`items[0]`), a substituting template, a string the qualified-name
grammar has no segment for (`obj["a-b"]`): the bracket contributes the reserved segment
`<computed>` — `prisma.<computed>.create` — and the call carries `dynamicReceiver`. The delegate
shape is intact, so the write is recorded again, at `medium` rather than `high` because the
model is not a name the source states. `<` is outside the segment grammar, so a target carrying
the sentinel resolves against nothing and lands in the `dynamic` diagnostic bucket rather than
matching whatever the shortened name would have found.

Two visible consequences: a call target may now carry a segment the source writes in brackets,
and `items[0].save()` reads as `items.<computed>.save` where it read as `items.save`.
