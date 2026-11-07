---
"@aburi/core": minor
"@aburi/cli": minor
---

A detected component's `publicApi` entries are now written from the workspace root, like `roots[]` and every Symbol id: `"exports": { ".": "./src/index.ts" }` in `packages/a/package.json` gives `packages/a/src/index.ts`, not `src/index.ts`. A diff against an IR scanned before this release reports each such component's `publicApi` as changed. A package at the workspace root keeps its entries as they were.

`aburi scan` now writes one line on stderr for each string `package.json` value that gives no entry (a directory, the package directory, an absolute path, a first segment that reads as a drive, a `..` segment, or a backslash), naming the component, the manifest field and the value. For example: `⚠ Component "demo": package.json#main is "./lib/", a directory rather than a file, so it gives no publicApi entry.`

`detectComponents` now returns `{ components, ignoredPublicApi }` in place of the `Component[]` it returned before.
