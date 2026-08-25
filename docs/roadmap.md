# Roadmap

Where Aburi stands today, and what comes next.

::: tip Status
The `v1` schemas are frozen. Every published package is implemented, unit
tested, and exercised end to end against a NestJS-shaped fixture project.
:::

## Working today

**Analysis** — TypeScript and JavaScript, parsed with tree-sitter WASM. pnpm and
npm workspaces detected automatically. NestJS, Next.js App Router, Express, and
React recognised as frameworks. Prisma, Drizzle, tRPC, and NestJS events
recognised as effects.

**Dependencies** — calls resolved to the symbols they reach within a file, an
import, a component, or the workspace, producing a symbol-level dependency
graph. Unresolved calls are counted and bucketed so you can see what the graph
is missing.

**Diff** — all six statuses (`added`, `removed`, `moved`, `changed`,
`moved+changed`, `dropped-toggled`), a `--fail-on` gate, and Slice View, which
clusters changed symbols along the call graph so a feature that cuts through
controller, service, and repository reads as one section.

**Output** — the JSON analysis, a workspace overview with a dependency diagram,
per-component detail, the pull-request diff, and per-symbol explain views.

**Delivery** — `@aburi/cli` on npm and `@aburi/github-action` for pull request
comments.

## Not yet

| Limitation | Status |
|---|---|
| TypeScript and JavaScript only | Other languages planned below |
| Effects are recorded where the call happens, not propagated to callers | [Designed](/design/effect-propagation), not implemented |
| Call resolution is syntactic — no type information | [LSP enrichment designed](/design/lsp-enrichment), not implemented |
| No graph visualisation beyond the workspace overview and Slice View | No design yet |
| No LLM integration | Deliberate. Aburi produces the facts; interpreting them is a separate tool's job |

## Next

- **LSP enrichment** — use type resolution to sharpen effect inference and fill
  in column-level source ranges.
- **`@aburi/framework-trpc`** — the server side of tRPC (`t.router`,
  `publicProcedure.query` / `mutation` / `subscription`). The existing
  `effects-trpc` covers the client call side only.

## Later

- **More languages** — Python and Go, with uv, poetry, cargo, and `go.work`
  workspace detection, and a single analysis spanning all of them in one
  monorepo.
- **More effects plugins** — Django, FastAPI, SQLAlchemy, GORM.
- **Large monorepos** — parallel parsing, targeting a 1,000-file scan in under
  30 seconds.
- **A functional language** — Scala or Rust, as the proof that the extension
  vocabulary can express pattern matching and algebraic data types.

## Under consideration

Nothing here is committed.

- Expose Aburi as an MCP server, callable directly from AI coding agents.
- `aburi review` — feed the diff to a model for automated review comments.
- Automatic naming of Slice View clusters, which are currently identified by id.
- A web UI for browsing the analysis.

---

Detailed specifications for everything above live in the
[design documents](/design/overview), and the JSON Schemas in
[`schema/`](https://github.com/kage1020/Aburi/blob/main/schema/).
