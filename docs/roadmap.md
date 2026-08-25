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

## Not yet

| Limitation | Status |
|---|---|
| TypeScript and JavaScript only | Other languages planned below |
| Effects sit where the call happens, without propagating to callers | [Designed](/design/effect-propagation), not implemented |
| Call resolution is syntactic, with no type information | [LSP enrichment designed](/design/lsp-enrichment), not implemented |
| No graph visualisation beyond the workspace overview and Slice View | No design yet |
| No LLM integration | Deliberate. Aburi produces the facts, and interpreting them belongs to a separate tool. |

## Next

- **LSP enrichment.** Use type resolution to sharpen effect inference and fill
  in column-level source ranges.
- **`@aburi/framework-trpc`.** The server side of tRPC (`t.router`,
  `publicProcedure.query` / `mutation` / `subscription`). The existing
  `effects-trpc` covers the client call side alone.

## Later

- **More languages.** Python and Go, with uv, poetry, cargo, and `go.work`
  workspace detection, and a single analysis spanning all of them in one
  monorepo.
- **More effects plugins.** Django, FastAPI, SQLAlchemy, GORM.
- **Large monorepos.** Parallel parsing, targeting a 1,000-file scan in under
  30 seconds.
- **A functional language.** Scala or Rust, proving that the extension
  vocabulary can express pattern matching and algebraic data types.

## Under consideration

Nothing here is committed.

- Expose Aburi as an MCP server, callable from AI coding agents.
- `aburi review`, feeding the diff to a model for automated review comments.
- Name Slice View clusters automatically. They carry ids today.
- Browse the analysis in a web UI.

---

The [design documents](/design/overview) specify everything above, and the JSON
Schemas live in [`schema/`](https://github.com/kage1020/Aburi/blob/main/schema/).
