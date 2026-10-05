---
"@aburi/core": patch
---

LSP enrichment now reads typescript-language-server's answers in the shapes that server sends. A `@throws` tag rendered as `*@throws* — {NotFoundError} …` or `*@throws* — RangeError` fills the caller's `Signature.inferredThrows`, read by the same rule as `signature.throws`, so a tag whose text is a description still names nothing. `this.` calls inside a generic class (`(method) Store<T>.count()`) resolve to their member, and so do calls inside a static method, which reach the static `Class::m` before an instance member of the same name. Decorated declarations and anonymous default exports get their `startColumn` / `endColumn`.

`inferredThrows` and the columns are not fingerprint inputs. With an effect plugin loaded, a caller whose `this.` call now resolves inherits that callee's effects, which moves its `logic` fingerprint. Before this release the call stayed unresolved, or, from a static method, resolved to an instance member of the same name.
