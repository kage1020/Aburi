---
"@aburi/lang-typescript": patch
"@aburi/core": patch
---

A JSDoc `@throws` tag without braces no longer records the first word of its description as a thrown type. `@throws If the id is unknown.` used to put `If` in `signature.throws`, so rewording the comment was reported as an API change and could trip `--fail-on api-changed`. A bare word now counts only when it is the tag's whole text and reads as a type name (`@throws PaymentDeclined`, `@throws Errors.NotFound`); anything else records nothing. TSDoc's `@throws {@link NotFoundError}` (and `{@linkcode …}`, `{@linkplain …}`) now records `NotFoundError` instead of `@link NotFoundError`, and a link that names no declaration, such as a URL, records nothing. A tag written later on the same line still ends the text before it, so `@throws A @throws B` records both.

`throws` is an input of the `api` fingerprint and one of the three terms of the `signatureSimilarity` score that pairs a renamed Symbol with its old self. A codebase with brace-less prose `@throws` therefore sees api changes on the first run after upgrading, on Symbols nobody touched, wherever an IR scanned before this release is compared with one scanned after; and a rename whose pairing leaned on those words may pair differently, or not at all. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with this release and is unaffected. On this repository, which writes its `@throws` braced or as a single type name, scanning one tree with both versions moves no fingerprint.

LSP enrichment keeps a reader of its own in `@aburi/core` for the `@throws` in a callee's hover, which fills `inferredThrows` and is not an `api` input. It now follows the same rule, so the two fields no longer disagree about what one tag declares.
