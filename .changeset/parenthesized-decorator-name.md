---
"@aburi/types": minor
"@aburi/lang-typescript": minor
---

A decorator written in parentheses is named after what it encloses

`@(Controller)` is legal TypeScript, and the extractor named it after its text, `(Controller)`. That
name matched no framework's vocabulary, so a class decorated that way stayed unclassified even when
the file imported `Controller` from `@nestjs/common`. `@(nest\n  .Controller)` also put a line break
into `Decorator.name`. A name, a member path or a call in parentheses is now read through them:
`Controller`, `Controller` with qualifier `nest`, and so on. `raw` still quotes the parentheses.

TypeScript accepts any expression there, but the grammar does not. `@(x as any)`, `@(x!)` and
`@(a[b])` reach the extractor only through error recovery, and there is no name to read from them.
They keep their place in the list under the reserved name `<expression>`, exported as
`UNNAMED_DECORATOR`, with the text in `raw`. `Decorator.name` is now always an identifier or that
marker.
