---
"@aburi/markdown-projection": patch
---

A changed Symbol's `component`, `visibility`, `signature.async`, `signature.generator` and `signature.typeParameters` rows in `diff.md` now give the value before and after, ``- visibility: `internal` → `public` ``, ``- component: `framework-express` → `core` ``, ``- signature.typeParameters: none → `<N extends SyntaxNode>` ``, `- signature.async: false → true`, where they read `changed` or `toggled` and left the reader to open both revisions to learn what moved. A Symbol outside every Component, and a signature without type parameters, read `none`. The values come from each entry's `before` and `after`, so a `diff.json` written by an earlier version renders the new rows too.
