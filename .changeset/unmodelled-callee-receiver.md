---
"@aburi/lang-typescript": patch
---

A call on a literal or other unnamed expression no longer withdraws the file

The callee normalizer copied the source text of any receiver it did not model into the call
target. `[...names].sort()` became `[...names].sort`, whose `...` is two empty segments, and every
effect plugin's segment guard threw on it, so the file and all of its Symbols were withdrawn and
`aburi scan` exited 3 — in files that never import the plugin's library. An IIFE put its whole
function body into `calls[].target`. Such a receiver (a literal, `new C()`, `await`, a binary
expression, a function expression) now contributes the reserved `<computed>` segment and marks the
call `dynamicReceiver`: `[...names].sort()` is `<computed>.sort`, an IIFE is `<computed>`.
`svc!.save()` and other type wrappers around a name keep their text; around anything else they
answer what they wrap, and a text holding an empty segment or a line break answers `<computed>`.

`calls[].target` does not reach the diff's fingerprints, but an effect's target is its call's
target, and `effects[].target` does. So a Symbol with an effect classified on such a receiver
shows `~` (logic) once after upgrading, and receivers that differed only in their text now share
one target: `new PrismaClient().user.create(…)` and `(await getDb()).user.create(…)` are both
`<computed>.user.create`, and their propagated effects merge into one entry where both reach a
caller. The first one's effect also drops from `high` to `medium` confidence, since the client's
name was only ever visible in the receiver's text.
