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

Extraction now collects the names a module hands to `export default` — one pass over the
module's own statements, not a search per declaration — and gives the matching top-level
declaration `public` visibility and `export-default` on `derivedBy`, before framework
classification runs.

The value is read through `unwrapValue`, the one reader that answers what a wrapper is for every
question this plugin asks about a node, so `export default Page satisfies NextPage` — and the
`(Page)`, `Page as FC` and `Page!` spellings — link back like the bare one. A framework reading
`export-default` does not depend on which was written, which is the whole of the point.

What the reading stops at is what is not a reference to a declaration: a call
(`export default withAuth(Page)`, where a value is returned by convention and nothing in the tree
says so), a value the module builds (`{ Page }`), a member of one (`Routes.Page`), and an
identifier that names an import, which declares nothing in the file to reach. `export { Page as
default }` is an export clause, and no clause spelling — `export { Page }` included — is read for
visibility yet; covering only the `default` one would make the answer depend on the clause's
contents.

A declaration reached by name is reached by a bare name. A class member called `Page`
(`Shell.Page`, `Shell::Page`) and a namespaced declaration (`Routes.Page`) carry a separator no
bare identifier can spell. A call Symbol's qname is a single identifier-legal segment with no
separator to rely on, so it is refused by kind instead: a registration statement is not a
declaration an `export default <identifier>` could be naming.
