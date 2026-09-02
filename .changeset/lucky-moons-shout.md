---
"@aburi/lang-typescript": minor
---

Parse JavaScript with a grammar that accepts JSX

`.js`, `.mjs` and `.cjs` were read with the TypeScript grammar, which does not accept JSX. The
JavaScript coverage exists so `@aburi/framework-react` can classify React sources in
plain-JavaScript codebases — Vite, CRA, `create-next-app`'s JavaScript template — and those
sources contain JSX. Every component body in them was unparsed, so nothing was classified, and
because the errors are recoverable the file still reached the IR: a diff read the Symbols it
never produced as deletions rather than as a file that could not be read.

The three JavaScript extensions now route to the tsx grammar, which is where `.jsx` already
went. The TypeScript extensions do not move.

What a JavaScript file gives up is the old-style type assertion `<T>expr` — legal TypeScript,
never legal JavaScript, and accepted in a `.js` file only because that file was being read as
TypeScript. It is the one construct the two grammars disagree about: measured over 6,000
published `.js` / `.cjs` / `.mjs` files, every one produces a byte-identical tree under both.

A React app written in JavaScript therefore gains its Symbols, their bodies and their framework
classification, and stops contributing to the recoverable-parse-error count that tells a reader
which files to distrust.
