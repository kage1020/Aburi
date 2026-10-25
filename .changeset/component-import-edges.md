---
"@aburi/core": minor
"@aburi/cli": minor
---

`aburi scan` now writes the edges between Components. Before this release, `dependencies[]` held only Symbol-to-Symbol `via: "call"` edges, so the Component dependencies graph in every `workspace.md` drew its nodes and no arrow, its fallback list read `_No Component edges recorded._`, and a diff never had a `Component-level added` or `Component-level removed` group.

For each pair of distinct Components where a file in one imports a module of the other, the IR now carries one `{ from, to, via: "import", direction: "outbound", effect: null }`. In a pnpm workspace, `packages/web/src/app.ts` writing `import { format } from "@acme/shared"` gives `acme-web` → `acme-shared`:

```
Fallback list:

- `acme-web` → `acme-shared` (via `import`)
```

Static imports, dynamic `import()`, re-exports and type-only imports all count. A relative specifier names the Component its joined path lies in, whether or not that path is a file the scan read. A bare specifier names a workspace package by its `package.json#name`, a subpath such as `@acme/shared/format` included. The packages are read at each `workspace.managers[].roots` entry and each Component root, and a package belongs to the Component that holds its `package.json`. A registry dependency, a Node built-in, a path alias, an import inside one Component, and the imports of a file the scan left out produce no edge. A resolved call between Components adds no edge of its own: a call matched only by a globally unique name is not evidence of a dependency.

Every IR of a workspace with more than one Component changes, and so does its `workspace.md`. A diff against an IR scanned before this release reports every Component edge as `Component-level added`. No fingerprint moves.

The scan now reads `package.json` at each root a config's `components[]` declares, as Component detection already did for the roots it finds. A manifest there that cannot be read or parsed stops the scan with exit 2 (`Failed to resolve components: …`), where it used to be ignored.

`@aburi/core`: `ScanInput` takes an optional `workspacePackages` (`{ name, root }[]`), which `readWorkspacePackages(workspaceRoot, roots)` reads. A caller that passes none gets edges from relative imports alone.
