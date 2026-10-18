---
"@aburi/markdown-projection": patch
---

The component diagram in `workspace.md` now writes every mermaid node id with a `c_` prefix, in node declarations and edges alike (`billing-api` → `c_billing_api`). Ids were written bare, and mermaid's flowchart grammar reads several valid component ids as keywords: a workspace package named `graph`, `flowchart`, `subgraph`, `end`, `style`, `class` or `interpolate`, or `click`, `call` or `href` at either end of an edge, made GitHub show a parse error in place of the whole diagram, and `click` at the start of an edge (`click --> api`) parsed as a click statement that dropped the edge. Component detection takes the id from `package.json#name`, or from the directory name when the manifest has none, so no configuration was needed to hit it.

The `Fallback list:` now follows every diagram, and the note that replaces a diagram past 100 nodes, also when the IR holds no Component edge, where it reads `_No Component edges recorded._`. It was emitted only when there was an edge, so a diagram that failed to render left no text form, and the note's "See list below." pointed at nothing. `aburi scan` writes Symbol edges only, so every scanned `workspace.md` with a component gains that list and sentence. A workspace with no component and no Component edge reads `_No Component edges recorded._` where it read `_No inter-component dependencies._`.

This change touches `workspace.md` alone: nothing in the IR, its fingerprints, the component pages or `diff.md` depends on the diagram's node ids or its list. A `workspace.md` kept under version control shows every node and edge line of its diagram changed once.
