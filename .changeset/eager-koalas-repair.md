---
"@aburi/lang-typescript": patch
---

Read `export default Page` as the export of the declaration it names

A default export written apart from its declaration — `const Page = () => …` on one line and
`export default Page` on the next — was not an export at all as far as extraction was concerned.
`isDefaultExport` reads the declaration's parent, and the parent of a top-level `const` is the
module: the statement that exports it is a sibling, and nothing linked the two.

So the Symbol reported `visibility = "internal"` and carried no `export-default`, which are the
two signals a framework plugin reads. `app/page.tsx` written this way classified as
`framework:react:component` and stayed internal, where the same file written `export default
function Page()` is a public `framework:next:page`. One of the two most common ways to write a
React component described a different boundary than the other.

Extraction now collects the names a module hands to `export default` as a bare identifier — one
pass over the module's own statements, not a search per declaration — and gives the matching
top-level declaration `public` visibility and `export-default` on `derivedBy`, before framework
classification runs.

Only that form links back. `export default withAuth(Page)` and `export default { Page }` export a
value the module computes rather than a declaration it wrote; `export { Page as default }` is an
export clause, which this plugin does not yet read for visibility in any of its spellings; and an
identifier naming an import declares nothing in the file to reach. Matching is by qualified name,
so a class member (`Shell.Page`) and a namespaced declaration (`Routes.Page`) carry a separator no
bare identifier can spell and cannot be reached by accident.
