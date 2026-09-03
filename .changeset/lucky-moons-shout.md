---
"@aburi/lang-typescript": minor
---

Parse JavaScript with a grammar that accepts JSX

`.js`, `.mjs` and `.cjs` were read with the TypeScript grammar, which does not accept JSX. The
JavaScript coverage exists so `@aburi/framework-react` can classify React sources in
plain-JavaScript codebases, and a React source written in `.js` contains JSX in `.js` — which
is what `create-next-app`'s JavaScript template emits and what CRA emitted.

The grammar recovers past JSX rather than failing, so the file still reached the IR and the
declarations mostly survived. What did not survive is everything from the first tag onwards:
the JSX a classifier reads to recognise a component, and every call written inside the markup.
On the `create-next-app` JavaScript template, both components came out `extKind: null` and a
handler written `onClick={() => track(c)}` contributed no call to any Symbol. A hook still
classified, because a hook is recognised by its name.

The three JavaScript extensions now route to the tsx grammar, which is where `.jsx` already
went. The TypeScript extensions do not move.

What a JavaScript file gives up is the old-style type assertion `<T>expr` — legal TypeScript,
never legal JavaScript, and accepted in a `.js` file only because that file was being read as
TypeScript. It is the only thing the tsx grammar refuses that the TypeScript grammar accepts:
measured over 6,000
published `.js` / `.cjs` / `.mjs` files, every one produces a byte-identical tree under both.

A React app written in JavaScript therefore gains the calls inside its markup, its framework
classification, and — where a declaration did not survive recovery — Symbols it did not have.
It also stops contributing to the recoverable-parse-error count, which is the only signal a
reader gets that a file's Symbol set may be short.
