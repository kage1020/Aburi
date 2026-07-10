# Roadmap

Per-version scope and progression plan for Aburi. The detailed designs (D1-D11) are finalized. This document covers only "what ships in which version".

Detailed designs live in [`docs/design/`](./design/overview); schemas in [`schema/`](https://github.com/kage1020/Aburi/blob/main/schema/).

---

## Design documents

| ID | Content | Document |
|---|---|---|
| D1 | Complete IR schema definition | [`ir-schema.md`](./design/ir-schema.md) + [`schema/aburi.ir.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.ir.v1.json) |
| D2 | Language plugin interface | [`lang-plugin.md`](./design/lang-plugin.md) |
| D3 | Effect plugin interface | [`effect-plugin.md`](./design/effect-plugin.md) |
| D4 | Fingerprint computation | [`fingerprint.md`](./design/fingerprint.md) |
| D5 | Component autodetect | [`component-detect.md`](./design/component-detect.md) |
| D6 | Diff algorithm | [`diff-algorithm.md`](./design/diff-algorithm.md) + [`schema/aburi.diff.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.diff.v1.json) |
| D7 | Extension vocabulary registration mechanism | [`extension-vocab.md`](./design/extension-vocab.md) + [`schema/aburi.plugin.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.plugin.v1.json) |
| D8 | Standard drop list set | [`drop-list.md`](./design/drop-list.md) |
| D9 | Markdown projection conventions | [`markdown-projection.md`](./design/markdown-projection.md) |
| D10 | CLI specification | [`cli-spec.md`](./design/cli-spec.md) |
| D11 | Config schema | [`config.md`](./design/config.md) + [`schema/aburi.config.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.config.v1.json) |

Every document is guaranteed to be readable without external context. Implementations must cite explicit § numbers when referencing them.

---

## v0.1: MVP (shipped)

The minimal configuration for validating value in PR review, released as version 0.1.0. All packages are built, unit-tested, and exercised end-to-end against the `fixtures/nestjs-billing` fixture; release automation via changesets is in place.

### Shipped scope

- **Languages**: TypeScript only (`.ts` / `.tsx`)
- **Parser**: Tree-sitter WASM (`web-tree-sitter` + `@vscode/tree-sitter-wasm`)
- **Workspace detection**: pnpm workspaces / npm workspaces (autodetect)
- **Framework hints**: NestJS / Next.js (App Router) — 2 plugins
- **Extraction**: drop list + local effect detection + Rule + Boundary
- **Commands**: `aburi init` / `aburi scan` / `aburi diff <base>..<head>` / `aburi explain`
- **Diff**: all 6 statuses — `added` / `removed` / `moved` / `changed` / `moved+changed` / `dropped-toggled`
- **Output**: JSON IR + Markdown projection (L1 + L2)
- **Distribution**: `@aburi/cli` + `@aburi/github-action`

### Out of scope

- LSP enrichment / effect propagation / L0 workspace overview (mermaid) / Slice View
- Languages other than TS
- LLM integration / graph visualization

---

## v0.2: Effect propagation and the vertical axis

### Additions

- **Effect propagation**: build the symbol call graph and propagate `db.write` to methods that call methods that call `prisma.invoice.create`
- **Symbol-to-symbol dependencies**: add symbol → symbol edges to the IR's `dependencies[]` (v0.1 has component → component only)
- **Slice View**: cluster a PR's changed symbol set into connected components over the call graph and render vertical slices in Markdown
- **L0 workspace overview**: output the full monorepo view as a mermaid graph
- **LSP optional enrichment**: improve effect-inference precision using type resolution (including filling in `SourceRange.startColumn` / `endColumn`)
- **Additional frameworks**: React function components / Express middleware
- **Additional effect plugins**: `@aburi/effects-prisma` / `@aburi/effects-drizzle` / `@aburi/effects-trpc`

### Detailed designs required before starting

- `call-resolution.md` — call resolution (in both untyped and LSP environments)
- `effect-propagation.md` — propagation rules
- `slice-view.md` — clustering algorithm selection (graph SCC vs. Louvain)
- `lsp-enrichment.md` — LSP communication / fallback conventions

### Out of scope

- Languages other than TS
- Implementation of the `fp:*` extension vocabulary for functional languages

---

## v1.0: Multi-language

### Additions

- **Language plugins**: Python (`@aburi/lang-python`) / Go (`@aburi/lang-go`)
- **Extended workspace detection**: uv / poetry / cargo / go.work
- **Cross-language IR**: output TS + Python + Go within the same monorepo under a unified schema (`components[].languages` holds multiple languages)
- **Extended effect plugins**: `@aburi/effects-django` / `@aburi/effects-fastapi` / `@aburi/effects-sqlalchemy` / `@aburi/effects-gorm`
- **Large monorepo support**: parallel parsing via a worker pool; `aburi scan` over >1000 files within 30 seconds
- **Functional-language plugin (proof of concept)**: one language, Scala or Rust; implementation of the `fp:match` / `fp:adt` extension vocabulary

### Detailed designs required before starting

- `multi-language-id.md` — cross-language symbol ID collision avoidance and cross-references
- `performance.md` — parallelization architecture
- `fp-extension-impl.md` — concrete specification of the `fp:*` extension vocabulary

---

## v1.x and beyond: candidates under consideration (not committed)

- Turn Aburi itself into an MCP server, callable directly from AI coding agents
- Feed IR diffs to an AI via `aburi review` to generate automated review comments (Aburi only produces the IR; the review goes through a separate tool)
- Automatic naming of Slice View clusters (currently cluster IDs only; naming is done by a human or an LLM)
- Visualize the IR in a Web UI
