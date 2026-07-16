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
- **Symbol-to-symbol dependency edges**: file-scope and import-scope call
  resolution filling `Symbol.calls[].resolved`, projected as `via: "call"`
  entries in `dependencies[]`
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
- **Call resolution is syntactic only** — file-scope and import-scope resolution
  (plus local-parameter shadow guarding) are wired up; component-scope,
  workspace-scope, and LSP-based resolution tiers are not
- **No LSP enrichment** — extraction is purely syntactic; no type resolution
  (LSP enrichment: [design landed](./design/lsp-enrichment.md); implementation upcoming)
- **No workspace-level mermaid overview / Slice View / graph visualization**
  (Slice View: design landed; implementation upcoming)
- **No LLM integration** — Aburi is a deterministic static analyser by design;
  AI-assisted review on top of the IR is a separate concern

---

## Next: effect propagation and the vertical axis

- **Effect propagation**: build on the symbol call graph and propagate `db.write`
  to methods that call methods that call `prisma.invoice.create`
- **Slice View**: cluster a PR's changed symbol set into connected components
  over the call graph and render vertical slices in Markdown
- **L0 workspace overview**: output the full monorepo view as a mermaid graph
- **[LSP optional enrichment](./design/lsp-enrichment.md)**: improve effect-inference precision using type
  resolution (including filling in `SourceRange.startColumn` / `endColumn`)
- **Additional frameworks**: React function components / Express middleware
- **Additional effect plugins**: `@aburi/effects-drizzle` / `@aburi/effects-trpc`

All detailed designs for this phase have landed:
`call-resolution.md`, `effect-propagation.md`, `slice-view.md`, and
`lsp-enrichment.md` — see the Design documents table below.

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
| Slice View clustering (weakly-connected components over the resolved call graph) | [`slice-view.md`](./design/slice-view.md) |
| Optional LSP enrichment (columns, typed dispatch, inferred throws) | [`lsp-enrichment.md`](./design/lsp-enrichment.md) |
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
