---
"@aburi/lang-typescript": patch
---

A JSDoc `@throws` tag without braces no longer records the first word of its description as a thrown type. `@throws If the id is unknown.` used to put `If` in `signature.throws`, so rewording the comment was reported as an API change and could trip `--fail-on api-changed`. A bare word now counts only when it is the tag's whole text and reads as a type name (`@throws PaymentDeclined`, `@throws Errors.NotFound`); anything else records nothing. TSDoc's `@throws {@link NotFoundError}` (and `{@linkcode …}`, `{@linkplain …}`) now records `NotFoundError` instead of `@link NotFoundError`.
