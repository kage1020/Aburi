---
"@aburi/lang-typescript": patch
---

A `const` initialised by a call now carries the functions it hands that call: `export const POST = withAuth(async (req) => { … })`, `memo(function Row() {…})`, `forwardRef((props, ref) => …)` and `t.procedure.query(() => …)` get the handler's rules, calls and effects. They were walked by nothing, so the const had none and no other Symbol held the code, and an edit to the handler moved no `logic` fingerprint and passed `--fail-on logic-changed`. The const stays a `const` with no signature (LP7b), and the reading is the one a registration statement already uses (LP20g): every function written as a direct argument of a call on the initializer's spine. The wrapping call itself is not recorded as one of the const's calls, and a function inside an argument (`withAuth(withLogging(fn))`) is still not walked. The `syntax` fingerprint is unchanged, because the const is still described by its whole declaration.

An IR scanned before this release compared with one scanned after reports a `logic` change on every such const whose wrapped function has a rule or an effect. On this repository, scanning one tree with both versions moves one Symbol's `logic` fingerprint, gives one more Symbol a call, and leaves every `syntax` fingerprint as it was.
