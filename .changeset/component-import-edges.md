---
"@aburi/core": minor
"@aburi/cli": minor
"@aburi/diff": minor
---

`aburi scan` now writes the edges between Components. Before this release, `dependencies[]` held only Symbol-to-Symbol `via: "call"` edges, so the Component dependencies graph in every `workspace.md` drew its nodes and no arrow, its fallback list read `_No Component edges recorded._`, and a diff never had a `Component-level added` or `Component-level removed` group.

For each ordered pair of distinct Components where a file in the first imports a module of the second, the IR now carries one `{ from, to, via: "import", direction: "outbound", effect: null }`. In a pnpm workspace, `packages/web/src/app.ts` writing `import { format } from "@acme/shared"` gives `acme-web` → `acme-shared`:

```
Fallback list:

- `acme-web` → `acme-shared` (via `import`)
```

Static imports, dynamic `import()`, re-exports, side-effect imports, `import x = require(…)` and type-only imports all count, and a bundler query such as `?raw` is dropped before the specifier is read. A relative specifier names the Component its joined path lies in, whether or not that path is a file the scan read; one that climbs exactly to the workspace root names the Component rooted at `.`. A bare specifier names a workspace package by its `package.json#name`, a subpath such as `@acme/shared/format` included. A package belongs to the Component that holds its `package.json`. A registry dependency, a Node built-in, a path alias, a CommonJS `require()` call, an import inside one Component, and the imports of a file the scan left out produce no edge. A package name the manifests of two Components declare names neither, and the scan warns once for each such name an import uses. A resolved call between Components adds no edge of its own: a call matched only by a globally unique name is not evidence of a dependency.

Every IR of a workspace where one Component imports another changes, and so does its `workspace.md`. A diff against an IR scanned before this release reports every Component edge as `Component-level added`. No fingerprint moves.

The scan now reads `package.json` at each workspace package root and each root a config's `components[]` declares, wherever a Component holds it; a root no Component holds is not read. A manifest it reads that cannot be read or parsed stops the scan with exit 2 (`Failed to resolve components: …`). Before this release a config that declared its Components never read those manifests, so the same tree scanned with exit 0. A malformed `package.json` at the workspace root still stops workspace detection first, with exit 1, as before.

A diff now reads a Component edge one side lacks as `unknown` when that side skipped a file of the Component the edge leaves, since any of those files could have held the import, and lists every such file in `lostFiles`. Before, a `parse-timeout` on one file put a `Component-level removed` line in the report for a dependency that still existed.

`@aburi/core`: `ScanInput` takes an optional `workspacePackages` (`{ name, root }[]`), which `readWorkspacePackages(workspaceRoot, roots)` reads; `NPM_MANIFEST` is exported beside it. A caller that passes none gets edges from relative imports alone. `@aburi/diff`: `DependencySideView` carries `componentLostFiles`, the skipped files of each Component, which `dependencySideView` fills in.
