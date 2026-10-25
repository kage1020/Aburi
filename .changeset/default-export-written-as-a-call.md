---
"@aburi/lang-typescript": minor
---

A default export written as a call handed a function now has a Symbol. `export default withAuth(async (req) => { … })` produced none, so the function written in the call had its calls, rules and effects on no Symbol, and an edit to it moved no fingerprint. It is now a `const` named `<default>`, read as a `const` initialised by the same call is: the functions handed directly to a call on the value's chain are its bodies, its `signature` is null, and `derivedBy` carries `call-argument-function` and `export-default`. The wrapping call is not one of its calls, and its normalized string is the whole statement. A caller importing the module's default reaches it. A call that only names a declaration (`export default withAuth(Page)`), a call handed no function (`export default defineConfig({ … })`) and one whose function sits inside another call's argument still produce no Symbol.

An IR scanned before this release, compared with one scanned after, reports each such default export as an added Symbol. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
