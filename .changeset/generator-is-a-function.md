---
"@aburi/lang-typescript": minor
---

A generator function is now read as a function wherever the plugin asks whether a value is one: a binding (`export const pages = function* () { yield fetchPage() }`, `async function*` included), an anonymous default export (`export default function* () { … }`), a class field, an object entry, a function a `const` hands to a call, and a registration's handler (Koa's `app.use(function* (ctx, next) { … })`). Before, `generator_function` was outside the set. The binding was a `const` with no body, and the anonymous default export produced no Symbol, so `fetchPage` and its effects were on no Symbol. A class field holding a generator stayed on the class, so constructing the class reported what iterating the generator does, and a class with no method was dropped as a `pure DTO` with the calls it carried. An object entry holding a generator was walked on its binding, and a call argument or a registration handler written as a generator was not walked at all. Each now gets what an arrow in the same place gets: the binding and the default export are `kind: "function"` with `signature.generator: true`, the field and the entry are `kind: "method"` Symbols of their own, and the call's const and the registration take the generator as a body.

What moves when an IR scanned before this release is compared with one scanned after:

- A binding to a generator changes `kind` and gains a `signature`, calls and effects. It is reported as changed in `api` and `syntax`, and in `logic` too when the body holds a rule or an effect.
- An anonymous default export written as a generator is a new `<default>` Symbol.
- A generator field or object entry becomes a new `method` Symbol, and its calls and effects leave the class or the binding that carried them.
- A const that hands a generator to a call, and a registration handed one, gain a body, its calls, and `call-argument-function` or `inline-handler` in `derivedBy`. Their `api` and `syntax` do not move, since both still describe the whole declaration or call; their `logic` moves when the body holds a rule or an effect.
- A class with no method and at least one generator field (`class C { id: string; pages = function* () {} }`) is no longer dropped (`dropped-toggled` to kept).

On this repository, scanning one tree with both versions gives the same Symbols and fingerprints, since its generators are all declarations. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
