# Roadmap

What Aburi can do today, what it cannot do yet, and what is planned next.

Detailed designs live in [`docs/design/`](./design/overview); schemas in [`schema/`](https://github.com/kage1020/Aburi/blob/main/schema/).

---

## What works today

- **Languages**: TypeScript (`.ts` / `.tsx`), parsed with Tree-sitter WASM
  (`web-tree-sitter` + `@vscode/tree-sitter-wasm`) — no native build step
- **Workspace detection**: pnpm workspaces / npm workspaces (autodetect)
- **Framework classification**: NestJS and Next.js (App Router) plugins
- **Effect detection**: Prisma (`db.read` / `db.write` / `db.transaction`) and
  NestJS events (`event.publish`) — local detection at the call site
- **Extraction**: drop list (boilerplate removal) + Rules + Boundaries + local Effects
- **Commands**: `aburi init` / `aburi scan` / `aburi diff <base>..<head>` / `aburi explain`
- **Diff**: all 6 statuses — `added` / `removed` / `moved` / `changed` /
  `moved+changed` / `dropped-toggled` — with a `--fail-on` CI gate
- **Output**: JSON IR (`aburi.ir.v1`) + Markdown projection (workspace overview,
  per-component detail, PR diff, per-Symbol explain)
- **Distribution**: `@aburi/cli` on npm + `@aburi/github-action` for PR comments

## Current limitations

- **TypeScript only** — no other languages yet
- **Effects are local** — an effect is attached to the method that makes the
  call, not propagated up through the call graph
- **No symbol-to-symbol dependency edges** — the IR carries component → component
  dependencies only
- **No LSP enrichment** — extraction is purely syntactic; no type resolution
- **No workspace-level mermaid overview / Slice View / graph visualization**
- **No LLM integration** — Aburi is a deterministic static analyser by design;
  AI-assisted review on top of the IR is a separate concern

---

## Next: effect propagation and the vertical axis

- **Effect propagation**: build the symbol call graph and propagate `db.write`
  to methods that call methods that call `prisma.invoice.create`
- **Symbol-to-symbol dependencies**: add symbol → symbol edges to the IR's
  `dependencies[]`
- **Slice View**: cluster a PR's changed symbol set into connected components
  over the call graph and render vertical slices in Markdown
- **L0 workspace overview**: output the full monorepo view as a mermaid graph
- **LSP optional enrichment**: improve effect-inference precision using type
  resolution (including filling in `SourceRange.startColumn` / `endColumn`)
- **Additional frameworks**: React function components / Express middleware
- **Additional effect plugins**: `@aburi/effects-drizzle` / `@aburi/effects-trpc`

Detailed designs required before starting:

- `slice-view.md` — clustering algorithm selection (graph SCC vs. Louvain)
- `lsp-enrichment.md` — LSP communication / fallback conventions

(`call-resolution.md` and `effect-propagation.md` were required for this phase and are now landed; see the Design documents table below.)

## Later: multi-language

- **Language plugins**: Python (`@aburi/lang-python`) / Go (`@aburi/lang-go`)
- **Extended workspace detection**: uv / poetry / cargo / go.work
- **Cross-language IR**: output TS + Python + Go within the same monorepo under
  a unified schema (`components[].languages` holds multiple languages)
- **Extended effect plugins**: `@aburi/effects-django` / `@aburi/effects-fastapi`
  / `@aburi/effects-sqlalchemy` / `@aburi/effects-gorm`
- **Large monorepo support**: parallel parsing via a worker pool; `aburi scan`
  over >1000 files within 30 seconds
- **Functional-language plugin (proof of concept)**: one language, Scala or
  Rust; implementation of the `fp:match` / `fp:adt` extension vocabulary

Detailed designs required before starting:

- `multi-language-id.md` — cross-language symbol ID collision avoidance and cross-references
- `performance.md` — parallelization architecture
- `fp-extension-impl.md` — concrete specification of the `fp:*` extension vocabulary

## Under consideration (not committed)

- Turn Aburi itself into an MCP server, callable directly from AI coding agents
- Feed IR diffs to an AI via `aburi review` to generate automated review
  comments (Aburi only produces the IR; the review goes through a separate tool)
- Automatic naming of Slice View clusters (currently cluster IDs only; naming
  is done by a human or an LLM)
- Visualize the IR in a Web UI

---

## Design documents

The full behaviour of everything in "What works today" is specified in
[`docs/design/`](./design/overview):

| Content | Document |
|---|---|
| Complete IR schema definition | [`ir-schema.md`](./design/ir-schema.md) + [`schema/aburi.ir.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.ir.v1.json) |
| Language plugin interface | [`lang-plugin.md`](./design/lang-plugin.md) |
| Call resolution (filling in `Call.resolved`) | [`call-resolution.md`](./design/call-resolution.md) |
| Effect propagation (augmenting `Symbol.effects[]` along resolved edges) | [`effect-propagation.md`](./design/effect-propagation.md) |
| Effect plugin interface | [`effect-plugin.md`](./design/effect-plugin.md) |
| Fingerprint computation | [`fingerprint.md`](./design/fingerprint.md) |
| Component autodetect | [`component-detect.md`](./design/component-detect.md) |
| Diff algorithm | [`diff-algorithm.md`](./design/diff-algorithm.md) + [`schema/aburi.diff.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.diff.v1.json) |
| Extension vocabulary registration mechanism | [`extension-vocab.md`](./design/extension-vocab.md) + [`schema/aburi.plugin.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.plugin.v1.json) |
| Standard drop list set | [`drop-list.md`](./design/drop-list.md) |
| Markdown projection conventions | [`markdown-projection.md`](./design/markdown-projection.md) |
| CLI specification | [`cli-spec.md`](./design/cli-spec.md) |
| Config schema | [`config.md`](./design/config.md) + [`schema/aburi.config.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.config.v1.json) |

Every document is readable without external context. Implementations must cite
explicit § numbers when referencing them.
