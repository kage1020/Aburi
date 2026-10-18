---
"@aburi/core": patch
---

`declaratorValue(statement, name)` returns the initializer of the declarator in a declaration statement that binds the plain identifier `name`, read through `unwrapValue`, and `null` when no declarator binds it, when it has no initializer, or when only a destructuring pattern binds it. `unwrapValue(node)` reads a value through parentheses, `as`, `satisfies` and `!`, the wrappers `@aburi/lang-typescript` reads through. A framework plugin classifying a `const` Symbol, whose node is the whole statement, reads the name's own initializer with them.
