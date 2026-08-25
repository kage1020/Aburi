<img src="docs/public/brand/mark.svg" alt="" width="72" height="72">

# Aburi

Aburi reads a pull request and reports **what changed**, not which lines moved.

It parses each revision with tree-sitter, matches functions and methods across
them, and writes a Markdown summary: this endpoint is new, this method now
writes to the database, this validation guard disappeared. CI can fail the build
on any of those.

**[aburi.kage1020.com](https://aburi.kage1020.com)** — documentation.

## What the report looks like

```md
# Aburi diff: main..HEAD

**Summary**: +2 added · -1 removed · ~3 changed · 1 moved

## ⚠ API changes

### `InvoiceService.createInvoice` *(method)*
**File**: `apps/billing/src/InvoiceService.ts:42`

- signature.outputs: `Promise<Invoice>` → `Promise<InvoiceWithReceipt>`
- decorator added: `@UseGuards(AuthGuard)`

## 🔧 Logic changes

### `RolesGuard.canActivate` *(method)*
**File**: `apps/billing/src/guards/roles.guard.ts:9`

- rules removed:
  - guard: `roles.length === 0` (L40)
- effects added:
  - db.write: `prisma.audit.create` (L75)
```

The removed guard is one line in `git diff`. Here it is a heading.

## Why not `git diff`

- A file rename with unchanged logic is reported as `moved`, not as a delete
  plus an add.
- A reformatting pass is reported as a syntax-only change and folded away.
- Interfaces, DTOs, re-exports, and empty bodies are dropped before the
  comparison, so they never pad the summary.
- Every category can be turned into a CI gate:
  `--fail-on 'removed,changed:>20'`.

It is a static analyser, not an LLM judge. The same commit always produces the
same report.

## Quick start

```bash
pnpm add -D @aburi/cli @aburi/lang-typescript @aburi/framework-nestjs

pnpm exec aburi init                # detect the project, write aburi.json
pnpm exec aburi scan                # analyse the workspace → out/
pnpm exec aburi diff main..HEAD --fail-on 'changed,removed:>5'
```

Exit code `3` means a gate tripped. Full walkthrough:
[Getting started](https://aburi.kage1020.com/guide/getting-started).

### In GitHub Actions

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: kage1020/Aburi/packages/github-action@main
  with:
    version: latest
    fail-on: "removed,dropped-toggled:to-dropped:>10"
```

The action posts the report as a pull request comment and rewrites the same
comment on every push.

## Documentation

| | |
|---|---|
| [What is Aburi?](https://aburi.kage1020.com/guide/what-is-aburi) | The idea, in five minutes. |
| [Getting started](https://aburi.kage1020.com/guide/getting-started) | Install to first diff. |
| [Reading the report](https://aburi.kage1020.com/guide/reading-the-report) | What each section means. |
| [Supported stacks](https://aburi.kage1020.com/guide/supported-stacks) | Which plugins cover your framework. |
| [CI integration](https://aburi.kage1020.com/guide/ci-integration) | Gates and pull request comments. |
| [CLI reference](https://aburi.kage1020.com/reference/cli) | Every flag and exit code. |
| [Architecture](https://aburi.kage1020.com/extend/architecture) | How the pipeline fits together. |
| [Plugin development](https://aburi.kage1020.com/extend/plugin-development) | Add a language, framework, or library. |
| [Roadmap](https://aburi.kage1020.com/roadmap) | What works today, what is next. |

Design documents live in [`docs/design/`](docs/design/) and the JSON Schemas in
[`schema/`](schema/).

## Contributing

Requires Node.js 24+ and pnpm (`corepack enable pnpm`).

```bash
pnpm install
pnpm check       # lint + format
pnpm typecheck
pnpm test
pnpm build
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md). New language, framework, and effects
plugins are especially welcome.

## License

MIT
