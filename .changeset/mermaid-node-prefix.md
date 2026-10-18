---
"@aburi/markdown-projection": patch
---

The component diagram in `workspace.md` now writes every mermaid node id with a `c_` prefix, in node declarations and edges alike (`billing-api` → `c_billing_api`). Ids were written bare, and mermaid's flowchart grammar reads several valid component ids as keywords: a workspace package named `graph`, `flowchart`, `subgraph`, `end`, `style`, `class` or `interpolate`, or `click`, `call` or `href` at the end of an edge, made GitHub show a parse error in place of the whole diagram. Component detection takes the id from `package.json#name`, so no configuration was needed to hit it.

The `Fallback list:` now follows every diagram, and the note that replaces a diagram past 100 nodes, also when no component depends on another, where it reads `_No inter-component dependencies._`. It was emitted only when there was an edge, so a diagram that failed to render left no text form, and the note's "See list below." pointed at nothing.

Only `workspace.md` changes. The IR, its fingerprints, the component pages and `diff.md` are the same as before, so an IR scanned before this release compared with one scanned after reports nothing. A `workspace.md` kept under version control shows every node and edge line of its diagram changed once.
