---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/framework-next": minor
"@aburi/framework-react": patch
---

A default export written as a call handed a function, which `@aburi/lang-typescript` now gives a `<default>` `const` Symbol, is classified as the same call bound to a name is. `@aburi/framework-next` gives an App Router file's role (`page`, `layout`, `template`, `loading`, `error`, `not-found`) to a default-exported `const` that carries `call-argument-function`, so `export default withAuth(function Page() { … })` and `const Page = withAuth(() => { … }); export default Page` are pages; a `const` default export that is not handed a function is still not one. `@aburi/framework-react` reads `export default memo(function Row() { … })` as a `framework:react:memo`, and `forwardRef(…)` as a `framework:react:forward-ref`, through `@aburi/core`'s `declaratorValue`, which now returns a default export statement's value, read through `unwrapValue`, when asked for the name `<default>`, and `null` for any other name. `@aburi/types` exports the token as `CALL_ARGUMENT_FUNCTION_DERIVED_BY`.

The `api` fingerprint reads `extKind`, so a `const` page bound apart from its default export, which had no role, moves `api` once. Rescan the base rather than comparing against a stored IR.
