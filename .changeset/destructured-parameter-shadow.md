---
"@aburi/types": minor
"@aburi/lang-typescript": patch
"@aburi/core": patch
---

A name a destructuring parameter binds now shadows outer names. `function f({ save }) { save() }` used to link `save()` to an imported or file-scope `save` and take on its effects, because the parameter was known only by its pattern text. Each `Signature.inputs` entry for a destructuring parameter now lists the names it binds in a new optional `bindings` field, and the call resolver treats each of them as a parameter, the same as `function f(save) { save() }`. A rest parameter whose binding destructures lists them too (`...[save]` is `{ name: "[save]", rest: true, bindings: ["save"] }`), while a single-name parameter, `...save` included, has no `bindings`: its `name` is already the binding. Where a syntax error leaves text inside the pattern that the parser could not place, only the names it did place are listed, and the file is scanned as before.
