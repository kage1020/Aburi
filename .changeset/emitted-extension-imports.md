---
"@aburi/core": patch
---

Relative imports written `./repo.js`, `.` or `..` resolve to the workspace file they name

Call resolution joined a relative specifier to the caller's directory and probed only that path,
`<path>.<ext>` and `<path>/index.<ext>`. A `node16`/`nodenext` project writes a relative import
of `repo.ts` as `./repo.js`, so every call through a relative import in such a project was left
unresolved (`no-match`: no call edge, no effect propagation) unless a later tier happened to
rescue it. A specifier with an emitted extension now probes the sources that compile to it
first, in TypeScript's order (`.js` → `.ts`, `.tsx`, `.js`, `.jsx`; `.jsx` → `.tsx`, `.ts`,
`.jsx`, `.js`; `.mjs` → `.mts`, `.mjs`; `.cjs` → `.cts`, `.cjs`).
The specifiers `.` and `..` are now read as relative (they were bucketed `external`), and a
specifier that names a directory (`.`, `..`, or one ending in `/`) probes only that directory's
index, so `./` no longer reaches a sibling `src.ts`.
