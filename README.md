<img src="docs/public/brand/mark.svg" alt="" width="72" height="72">

# Aburi

Aburi reads a pull request and tells you what the change did: which endpoints
are new, which methods now write to the database, which validation guard
disappeared.

It parses both revisions with tree-sitter, matches functions and methods across
them, and writes the answer as Markdown. Your CI can fail the build on any of it.

Documentation: **[aburi.kage1020.com](https://aburi.kage1020.com)**

## What the report looks like

```md
# Aburi diff: main..HEAD

**Summary**: +2 added · -1 removed · ~3 changed · 1 moved

## ⚠ API changes

### `submitOrder` *(function)*
**File**: `src/app/orders/actions.ts:18`

- signature.outputs: `Promise<Order>` → `Promise<OrderWithReceipt>`
- signature.throws added: `PaymentDeclined`

## 🔧 Logic changes

### `POST` *(function)*
**File**: `src/app/api/orders/route.ts:9`

- rules removed:
  - guard: `session.user.role !== 'admin'` (L14)
- effects added:
  - db.write: `prisma.auditLog.create` (L31)
```

That deleted guard is a single red line somewhere in a 2,000-line `git diff`.
Aburi gives it a heading.

## Why not `git diff`

Rename a file without touching its logic and Aburi reports `moved`, where
`git diff` reports a delete plus an add. Reformat a body and Aburi files it
under syntax-only changes, folded out of your way. Interfaces, DTOs,
re-exports, and empty bodies drop out before the comparison, so they stay out
of the summary.

Aburi runs static analysis. No model, no sampling, so the same commit produces
the same report, and you can gate CI on any category it counts:
`--fail-on 'removed,changed:>20'`.

## Quick start

```bash
pnpm add -D @aburi/cli @aburi/lang-typescript @aburi/framework-next @aburi/framework-react

pnpm exec aburi init                # detect the project, write aburi.json
pnpm exec aburi scan                # analyse the workspace → out/
pnpm exec aburi diff main..HEAD --fail-on 'removed,changed:>20'
```

With another package manager, install with `npm install -D …`, `yarn add -D …`,
or `bun add -D …`, and run the CLI as `npx aburi …`, `yarn aburi …`, or
`bunx aburi …`.

Exit code `3` means a gate tripped. The full walkthrough is in
[Getting started](https://aburi.kage1020.com/guide/getting-started).

### In GitHub Actions

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with: { node-version: 24, cache: pnpm }
- run: pnpm install --frozen-lockfile
- uses: kage1020/Aburi/packages/github-action@main
  with:
    cli: workspace
    fail-on: "removed,dropped-toggled:to-dropped:>10"
```

The action posts the report as a pull request comment, and rewrites that same
comment on every push.

`cli: workspace` runs the CLI your lockfile pinned, which is also what makes the
plugins above resolve. Drop the install steps and set `version: latest` instead and
the action fetches the CLI with `pnpm dlx` — no install, but no plugins either.
Aburi runs itself this way: [`.github/workflows/aburi.yml`](.github/workflows/aburi.yml).

## Documentation

| | |
|---|---|
| [What is Aburi?](https://aburi.kage1020.com/guide/what-is-aburi) | The idea, in five minutes. |
| [Getting started](https://aburi.kage1020.com/guide/getting-started) | Install to first diff. |
| [Reading the report](https://aburi.kage1020.com/guide/reading-the-report) | What each section means. |
| [Supported stacks](https://aburi.kage1020.com/guide/supported-stacks) | Which plugins cover your framework. |
| [Configuration](https://aburi.kage1020.com/guide/configuration) | Every field of `aburi.json`. |
| [CI integration](https://aburi.kage1020.com/guide/ci-integration) | Gates and pull request comments. |
| [CLI reference](https://aburi.kage1020.com/reference/cli) | Every flag and exit code. |
| [Architecture](https://aburi.kage1020.com/extend/architecture) | How the pipeline fits together. |
| [Plugin development](https://aburi.kage1020.com/extend/plugin-development) | Add a language, framework, or library. |
| [Roadmap](https://aburi.kage1020.com/roadmap) | What works today, what is next. |

Design documents live in [`docs/design/`](docs/design/), the JSON Schemas in
[`schema/`](schema/). The site serves each schema at the `$id` it carries, so
`https://aburi.kage1020.com/schema/aburi.config.v1.json` is the same file your
editor resolves from the `$schema` line of an `aburi.json`.

## Contributing

You need Node.js 24+ and pnpm (`corepack enable pnpm`).

```bash
pnpm install
pnpm check       # lint + format
pnpm typecheck
pnpm test
pnpm build
```

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before you open a pull request. We
would love new language, framework, and effects plugins.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
