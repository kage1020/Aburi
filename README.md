# Aburi

Aburi extracts a **semantic intermediate representation (IR)** from source code so
reviewers can read pull requests at the level of business logic, control flow, and
module boundaries instead of raw diffs. It is a static analyser (not an LLM
judge): parses with tree-sitter, matches Symbols across revisions with a 5-stage
semantic diff, and emits a JSON IR plus a decision-focused Markdown projection
that CI can gate on.

> **Status: v0.1.** The v1 JSON Schemas are frozen. Every package listed below
> is implemented, unit-tested, and exercised end-to-end against
> `fixtures/nestjs-billing/`.

**Documentation: [aburi.kage1020.com](https://aburi.kage1020.com)**

## Why not just `git diff`

`git diff` shows *what changed textually*. Aburi shows *what changed semantically*:

- A file rename with unchanged logic surfaces as `moved: 1` — not `removed + added`.
- Adding a validation guard to a method surfaces as `changed: 1, logicChanged: true` —
  and can be gated in CI via `--fail-on changed:>0`.
- Boilerplate (interfaces, re-exports, empty bodies) is dropped from the diff so
  the reviewer sees only the changes that carry meaning.
- A refactor that stubs 12 method bodies surfaces as `dropped-toggled:to-dropped: 12`
  with a single-token CI gate (`--fail-on dropped-toggled:to-dropped:>10`).

## Quick start

### Install

```bash
pnpm add -D @aburi/cli @aburi/lang-typescript @aburi/framework-nestjs
# (or your framework: @aburi/framework-next; effects: @aburi/effects-prisma, @aburi/effects-nest)
```

### Autodetect + config

```bash
pnpm exec aburi init
# → writes aburi.json with detected languages / frameworks / components
```

### Scan the workspace to IR + Markdown

```bash
pnpm exec aburi scan
# → out/aburi.ir.json      (canonical JSON, aburi.ir.v1 schema)
# → out/workspace.md       (L0 workspace overview)
# → out/components/*.md    (L1 + L2 per-component detail)
```

### Diff a PR

```bash
# Quote --fail-on: `>` is a shell redirect if left bare.
pnpm exec aburi diff main..HEAD --fail-on 'changed,removed:>5'
# → out/diff.json          (aburi.diff.v1 schema)
# → out/diff.md            (review-facing Markdown)
# exit 0 = clean, 3 = --fail-on gate tripped
```

### Post to a PR from GitHub Actions

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: kage1020/Aburi/packages/github-action@main
  with:
    version: latest
    fail-on: "removed,dropped-toggled:to-dropped:>10"
```

The action runs `aburi diff` on the PR base..head and upserts the Markdown as a
hidden-marker PR comment (rewrites in place on every push, no comment spam).

## Architecture at a glance

```
source files
  ↓ (@aburi/lang-typescript, @aburi/lang-*)          tree-sitter parseFile / extractSymbols
  ↓ (@aburi/framework-nestjs, @aburi/framework-next) classifySymbol → extKind (framework:*)
  ↓ (@aburi/effects-prisma, @aburi/effects-nest)     classifyCall → Effect (db.read / event.publish / …)
  ↓ (@aburi/core scan)                               walkBody → Rules + Calls + Effects
  ↓                                                  drop rules (interfaces, empty bodies, re-exports)
  ↓                                                  fingerprint per Symbol (api / logic / syntax)
  ↓                                                  IR integrity check (11 invariants)
  ↓
aburi.ir.v1.json  ─────────────────────────────────────────  Source of Truth (L3)
  │
  ├─ @aburi/markdown-projection  workspace.md / component/*.md   (L0 / L1 / L2 views)
  ├─ @aburi/diff                 5-stage matcher → aburi.diff.v1  (base IR + head IR → diff)
  └─ @aburi/cli explain          per-Symbol Markdown detail
```

Everything downstream of `aburi.ir.v1.json` is deterministically derived from it.
Same IR in → same Markdown / same diff out.

## Package matrix

| Package | Layer | What it does |
|---|---|---|
| [`@aburi/types`](packages/types) | Foundation | Schema-generated IR / config / diff / plugin types + hand-written plugin interfaces. |
| [`@aburi/plugin-registry`](packages/plugin-registry) | Foundation | Plugin manifest validator + vocab registry (owned extKinds / effect ids / namespaces). |
| [`@aburi/config`](packages/config) | Foundation | JSONC + ajv-validated `aburi.json` loader with framework-hint normalisation. |
| [`@aburi/core`](packages/core) | Foundation | Symbol ID generation, canonical JSON, 11 IR invariants, autodetect (workspace / managers / components), scan orchestration. |
| [`@aburi/lang-typescript`](packages/lang-typescript) | Language | TS/TSX language plugin (tree-sitter WASM), JSDoc-aware signature + throws, drop-hint contract. |
| [`@aburi/framework-nestjs`](packages/framework-nestjs) | Framework | `@Module` / `@Controller` / `@Injectable` / HTTP + WS + pattern decorators → `framework:nestjs:*` extKinds. |
| [`@aburi/framework-next`](packages/framework-next) | Framework | App Router files (page / layout / route / …) → `framework:next:*` extKinds. |
| [`@aburi/effects-prisma`](packages/effects-prisma) | Effects | `prisma.<model>.<verb>` / `$transaction` → `db.read` / `db.write` / `db.transaction`. |
| [`@aburi/effects-nest`](packages/effects-nest) | Effects | `EventEmitter2` / `eventBus` `.emit(...)` → `event.publish`. |
| [`@aburi/diff`](packages/diff) | Diff | 5-stage matcher (id / git-rename / logic-fingerprint / name+signature / dropped-weak) + status + delta. |
| [`@aburi/markdown-projection`](packages/markdown-projection) | Projection | Workspace / component / diff / explain Markdown views + `--fail-on` formatter. |
| [`@aburi/cli`](packages/cli) | CLI | `aburi init / scan / diff / explain`, git-worktree ref diff, exit codes 0 / 1 / 2 / 3, `--fail-on` gate. |
| [`@aburi/github-action`](packages/github-action) | Delivery | Composite GH Action wrapper around the CLI, marker-based PR comment upsert. |

Design docs: [`docs/design/`](docs/design/) (overview + 11 topical designs),
[`docs/roadmap.md`](docs/roadmap.md), [`schema/`](schema/) (JSON Schemas).

Reference: [`docs/cli-reference.md`](docs/cli-reference.md),
[`docs/plugin-development.md`](docs/plugin-development.md) — rendered at
[aburi.kage1020.com](https://aburi.kage1020.com).

## Requirements

- Node.js `>= 24`
- pnpm (managed via `packageManager`; enable with `corepack enable pnpm`)

## Local development

```bash
pnpm install
pnpm check       # Biome lint + format check
pnpm typecheck   # tsc --noEmit across packages (turbo)
pnpm test        # Vitest across packages
pnpm build       # tsdown across packages
```

Fixture used by the integration suite:
[`fixtures/nestjs-billing/`](fixtures/nestjs-billing) — a small NestJS-shaped
billing service that exercises boundary routes, providers, modules, and a
12-method service that scenario B mutates to prove the `--fail-on
dropped-toggled:to-dropped:>10` gate.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). New language / framework / effects
plugins are especially welcome — start from
[`docs/plugin-development.md`](docs/plugin-development.md).

## License

MIT
