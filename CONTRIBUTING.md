# Contributing to Aburi

Thanks for your interest in contributing! This document explains how to set up
a development environment and what we expect from contributions.

## Prerequisites

- Node.js `>= 24`
- pnpm (pinned via the `packageManager` field; enable with `corepack enable pnpm`)

## Setup

```bash
git clone https://github.com/kage1020/Aburi.git
cd Aburi
pnpm install
```

## Development commands

```bash
pnpm check       # Biome lint + format check (pnpm format to write fixes)
pnpm typecheck   # tsc --noEmit across packages (turbo)
pnpm test        # Vitest across packages
pnpm build       # tsdown across packages
```

All four must pass before a pull request can merge — CI runs them on Ubuntu,
macOS, and Windows.

## Workflow

1. Branch from `main` (`main` is protected; changes always land via PR).
2. Follow a test-first flow: define acceptance criteria from the relevant
   design doc under [`docs/design/`](docs/design/), write the tests, then the
   implementation.
3. If the change affects a published package, add a changeset:
   `pnpm changeset`.
4. Open a pull request against `main`.

## Design docs

Behaviour is specified before it is implemented. Every package's contract
lives under [`docs/design/`](docs/design/), and the JSON Schemas under
[`schema/`](schema/) are the source of truth for the IR, diff, config, and
plugin manifest shapes. If your change alters a contract, update the design
doc and schema in the same PR.

The `v1` schemas are frozen: additive changes only. Anything that would break
an existing consumer of `aburi.ir.v1.json` / `aburi.diff.v1.json` needs a new
schema version.

## Writing plugins

New language / framework / effects plugins are the most welcome kind of
contribution. See [`docs/plugin-development.md`](docs/plugin-development.md)
for the plugin contracts and a walkthrough.

## Conventions

- ESM only, TypeScript strict mode, no `any` escapes.
- Never hardcode dependency versions in `package.json` — install via
  `pnpm add` so the latest compatible version is recorded.
- No linter-suppression comments; fix the root cause instead.
- Generated files (`packages/types/src/generated/`) are regenerated from
  `schema/` — never edit them by hand.

## Releases

Releases are cut from `main` via [changesets](https://github.com/changesets/changesets):
merging the release PR created by the release workflow publishes the packages
to npm.
