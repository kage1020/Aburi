# Roadmap

Where Aburi stands today, and what comes next.

::: tip Status
The `v1` schemas are frozen. Every published package is implemented, unit
tested, and exercised end to end against a NestJS-shaped fixture project.
:::

## Working today

**Analysis.** TypeScript and JavaScript, parsed with tree-sitter WASM. Aburi
detects pnpm and npm workspaces on its own, recognises NestJS, Next.js App
Router, Express, and React as frameworks, and reads Prisma, Drizzle, tRPC, and
NestJS events as effects.

**Dependencies.** Aburi resolves calls to the symbols they reach within a file,
an import, a component, or the workspace, and builds a symbol-level dependency
graph from them. It counts and buckets the calls it could not resolve, so you
can see what the graph is missing.

**Diff.** All six statuses (`added`, `removed`, `moved`, `changed`,
`moved+changed`, `dropped-toggled`), a `--fail-on` gate, and Slice View, which
clusters changed symbols along the call graph so a feature cutting through
controller, service, and repository reads as one section.

**Output.** The JSON analysis, a workspace overview with a dependency diagram,
per-component detail, the pull request diff, and per-symbol explain views.

**Delivery.** `@aburi/cli` on npm, and `@aburi/github-action` for pull request
comments.

**Performance.** Measured monthly against nine public repositories at pinned
commits, from `zustand`'s 49 files to `cal-com`'s 5,002. On a 4-core runner a
1,081-file scan takes 3.7 s and a 5,002-file one 14.7 s, single-threaded, with no
scan passing 470 MiB peak — cost is roughly linear in file count. Three
consecutive scans of an unchanged tree produce byte-identical IR.

## Not yet

| Limitation | Status |
|---|---|
| TypeScript and JavaScript only | Other languages planned below |
| Effects sit where the call happens, without propagating to callers | [Designed](./design/effect-propagation.md), not implemented |
| Call resolution is syntactic, with no type information — 2–19% of call sites resolve on public repositories | [LSP enrichment designed](./design/lsp-enrichment.md), not implemented |
| No graph visualisation beyond the workspace overview and Slice View | No design yet |
| No LLM integration | Deliberate. Aburi produces the facts, and interpreting them belongs to a separate tool. |

## Next

- **LSP enrichment.** Use type resolution to sharpen effect inference and fill
  in column-level source ranges. The number it has to beat is measured: between
  2.0% of call sites resolved on NestJS itself, where a callee is a
  constructor-injected interface, and 18.7% on `zod`. `no-match` is the largest
  unresolved bucket almost everywhere, and classifying a sample of it comes
  first — whatever share is a resolver gap rather than a genuinely unknowable
  callee is fixable without type information at all.
- **`@aburi/framework-trpc`.** The server side of tRPC (`t.router`,
  `publicProcedure.query` / `mutation` / `subscription`). The existing
  `effects-trpc` covers the client call side alone.

## Later

- **More languages.** Python and Go, with uv, poetry, cargo, and `go.work`
  workspace detection, and a single analysis spanning all of them in one
  monorepo.
- **More effects plugins.** Django, FastAPI, SQLAlchemy, GORM.
- **Large monorepos.** A 1,000-file scan finishes in under 30 seconds
  single-threaded, so the [worker pool](./design/performance.md) would buy at
  best ~4× on a 4-core runner — the ideal scaling, unmeasured — on a workload
  already inside its budget. What is left to parallelise is `aburi diff`, which
  runs two scans and costs a measured 1.7–2.2× one; two independent scans are
  cheaper to run at once than one sharded scan.
- **A functional language.** Scala or Rust, proving that the extension
  vocabulary can express pattern matching and algebraic data types.

## Under consideration

Nothing here is committed.

- A merge-base ref form, `aburi diff main...HEAD`, comparing the head against
  the point it branched from the way a GitHub compare URL reads. Today the
  three-dot spelling is rejected with a message pointing at `git merge-base`.
- Expose Aburi as an MCP server, callable from AI coding agents.
- `aburi review`, feeding the diff to a model for automated review comments.
- Name Slice View clusters automatically. They carry ids today.
- Browse the analysis in a web UI.

---

The [design documents](./design/overview.md) specify everything above, and the JSON
Schemas live in [`schema/`](https://github.com/kage1020/Aburi/blob/main/schema/).
