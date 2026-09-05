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

Two workflows then run. CI runs the four commands above on Ubuntu, macOS and Windows,
and Aburi runs on itself: [`.github/workflows/aburi.yml`](.github/workflows/aburi.yml)
builds your branch, diffs it against the pull request's base with the CLI your branch
contains, and posts the report as a comment it rewrites on every push. (From a fork, the
token is read-only: there is no comment, and the report is the `aburi-diff` artifact on
the run.) Its gate (`removed,dropped-toggled:to-dropped:>10`) turns the check red when a
symbol disappears or bodies are emptied in bulk.

The job has no bypass switch: a tripped gate stays red for that commit. Say in the pull
request why the removal is deliberate — merging past a red Aburi check is then a
maintainer's call, and the design docs are what the argument is made against.

Two things about this repository's own dogfooding are worth knowing before they surprise
you:

- A fresh `pnpm install` warns `Failed to create bin at …/node_modules/.bin/aburi`. That
  is expected. The root `package.json` depends on `@aburi/cli`, whose bin is build output
  and does not exist yet at install time; nothing needs the link, because the action
  resolves the package rather than the link
  ([`docs/design/github-action.md`](docs/design/github-action.md) §3).
- There is an `aburi.json` at the repository root, and config discovery walks parent
  directories to the filesystem root. A test fixture built inside the repository would
  pick it up; build fixtures under `os.tmpdir()`, as the existing ones do.

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
contribution. See [`docs/extend/plugin-development.md`](docs/extend/plugin-development.md)
for the plugin contracts and a walkthrough.

## Docs site

[aburi.kage1020.com](https://aburi.kage1020.com) is the VitePress site under
[`docs/`](docs/), served by a Cloudflare Worker configured in
[`docs/wrangler.jsonc`](docs/wrangler.jsonc). Cloudflare's git integration
watches the repository directly — there is no deploy workflow in
`.github/workflows/`, so changing CI will not change how the site ships.

Pushing to `main` deploys production. Pushing to any other branch uploads a
*version* instead: the site is built and reachable at a preview URL, but no
traffic moves off the deployed version. Cloudflare comments that URL on the
pull request and rewrites the comment on every push, so the link in a review
always points at the commit being reviewed.

Two things make that work, one in this repository and one outside it:

- `preview_urls` in [`docs/wrangler.jsonc`](docs/wrangler.jsonc). It is set
  explicitly because the default follows `workers_dev`, and because Wrangler
  overwrites the dashboard toggle on every deploy.
- **Workers & Pages → aburi → Settings → Build → Branch control**: *Builds for
  non-production branches* must be enabled, or pull requests get no preview at
  all. This is the only step that cannot live in the repository.

Because this is a monorepo, a pull request that touches no documentation still
triggers a docs build. **Build → Build watch paths** can narrow that to
`docs/*` if the noise becomes a problem.

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
