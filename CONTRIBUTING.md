# Contributing to Aburi

Thanks for your interest in contributing! This document explains how to set up
a development environment and what we expect from contributions.

## Prerequisites

- Node.js `>= 24`
- pnpm (pinned via the `packageManager` field; enable with `corepack enable pnpm`)

## Setup

```bash
git clone https://github.com/aburi-dev/Aburi.git
cd Aburi
pnpm install
```

## Development commands

```bash
pnpm check       # Biome lint + format check (pnpm format to write fixes)
pnpm hygiene     # no citations of design docs, spec ids or issues in code
pnpm typecheck   # tsc --noEmit across packages (turbo)
pnpm test        # Vitest across packages
pnpm build       # tsdown across packages
```

All five must pass before a pull request can merge — CI runs them on Ubuntu,
macOS, and Windows.

## Workflow

1. Branch from `main`; changes always land via PR.
2. Follow a test-first flow: define acceptance criteria from the relevant
   design doc under [`docs/design/`](docs/design/), write the tests, then the
   implementation.
3. If the change affects a published package, add a changeset:
   `pnpm changeset`. A change that moves a stored fingerprint of previously
   correct output, so that an IR scanned before the release, compared with one
   scanned after, reports Symbols nobody edited as changed, is `minor`; `patch`
   only when no stored fingerprint moves.
4. Open a pull request against `main`.

Two workflows then run on your pull request. CI runs the five commands above on Ubuntu, macOS
and Windows, and Aburi runs on itself: [`.github/workflows/aburi.yml`](.github/workflows/aburi.yml)
builds your branch, diffs it against the pull request's base with the CLI your branch
contains, and posts the report as a comment it rewrites on every push. Its gate
(`removed,dropped-toggled:to-dropped:>10`) turns the check red when a symbol disappears or
bodies are emptied in bulk. A helper deleted while one with the same body stays does not count
when that body holds a guard (an `if` that returns or throws), a `throw`, a `switch`, a computed
return value or an effect: the report lists it as a removed duplicate of the one that stayed. A
body that only calls something, or returns a literal, a variable or a property, has nothing to
compare, so deleting it still counts. With `fail-on-scope: non-test` the gate skips the files the
`testFiles` in [`aburi.json`](aburi.json) name (the tests, the test helpers and the showcase's
sample projects) and lists their changes in the report's folded `🧪 Test files` section
instead. Every other file the scan reads counts, the docs site, `examples/src` and the
repository's scripts included. That section comes last, so it is the first one the comment's size
cap drops on a large pull request; `diff.full.md` in the run's `aburi-diff` artifact holds the
whole report.

From a fork, that run's token is read-only and cannot post, so a third workflow does it:
[`aburi-comment.yml`](.github/workflows/aburi-comment.yml) picks the report up from the
`aburi-diff` artifact afterwards and comments with this repository's own token. It posts no
check of its own — the comment appearing is the signal — so expect it a minute or so after the
Aburi check finishes, and if it never arrives, the report is still that artifact on the run.

The job has no bypass switch: a tripped gate stays red for that commit. Say in the pull
request why the removal is deliberate — merging past a red Aburi check is then a
maintainer's call, and the design docs are what the argument is made against.

The repository's own `aburi.json` loads no effects plugin, so the self-run's report never shows an
effect. The test suite pins them instead:
[`effects-coverage.test.ts`](packages/cli/test/e2e/effects-coverage.test.ts) scans a fixture that
calls the libraries the effects plugins model, diffs one edit per plugin, and compares what each
plugin attributes with a recorded list, so a change in what a plugin attributes fails until that
list is updated.

Two things about this repository's own dogfooding are worth knowing before they surprise
you:

- A fresh `pnpm install` warns `Failed to create bin at …/node_modules/.bin/aburi`. That
  is expected. The root `package.json` depends on `@aburi/cli`, whose bin is build output
  and does not exist yet at install time; nothing needs the link, because the action
  resolves the package rather than the link
  ([`docs/design/github-action.md`](docs/design/github-action.md)).
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

[aburi.dev](https://aburi.dev) is the VitePress site under
[`docs/`](docs/), served by a Cloudflare Worker configured in
[`docs/wrangler.jsonc`](docs/wrangler.jsonc). Production is deployed from
[`.github/workflows/docs.yml`](.github/workflows/docs.yml); previews still come
from Cloudflare's git integration, which watches the repository directly. The
site's `build` script first builds the workspace packages it renders — the
Showcase runs the CLI over `examples/` — so whatever runs `pnpm --filter
@aburi/docs build` gets a complete site.

**Production ships with the release, not with the merge.**
[`release.yml`](.github/workflows/release.yml) calls the docs workflow only on
the run where changesets actually published to npm, so the site never documents
a version that cannot be installed yet. A documentation fix that should not
wait for the next release can be shipped on its own by running the **Docs**
workflow from the Actions tab.

Pushing to a branch other than `main` uploads a *version*: the site is built
and reachable at a preview URL, but no traffic moves off the deployed version.
Cloudflare comments that URL on the pull request and rewrites the comment on
every push, so the link in a review always points at the commit being reviewed.

Two things make the previews work, one in this repository and one outside it:

- `preview_urls` in [`docs/wrangler.jsonc`](docs/wrangler.jsonc). It is set
  explicitly because the default follows `workers_dev`, and because Wrangler
  overwrites the dashboard toggle on every deploy.
- **Workers & Pages → aburi → Settings → Build → Branch control**: *Builds for
  non-production branches* must be enabled, or pull requests get no preview at
  all.

And two make the release-time deploy work, neither of which lives in the
repository:

- On that same **Branch control** screen, builds for the **production branch**
  must be *disabled*. Left on, every push to `main` deploys the site the moment
  it merges, and the release-time deploy is only a second deploy of something
  already live — which is the coupling this arrangement exists to break.
- Two repository secrets, because Cloudflare has no equivalent of the OIDC
  trusted publishing the npm release leans on: `CLOUDFLARE_API_TOKEN` (a token
  with *Workers Scripts: Edit* on this account) and `CLOUDFLARE_ACCOUNT_ID`.

Because this is a monorepo, a pull request that touches no documentation still
triggers a preview build. **Build → Build watch paths** can narrow that to
`docs/*` if the noise becomes a problem.

## Conventions

- ESM only, TypeScript strict mode, no `any` escapes.
- Never hardcode dependency versions in `package.json` — install via
  `pnpm add` so the latest compatible version is recorded.
- A dependency that two or more workspace packages declare is a `catalog:`
  entry, so its range is kept once, in `pnpm-workspace.yaml`. `pnpm add` writes
  `catalog:` for a name the catalog already lists; `pnpm add <dep> --save-catalog`,
  run for every package that declares it, moves a newly shared one there.
- No linter-suppression comments; fix the root cause instead.
- Generated files are never edited by hand:
  `packages/types/src/generated/` is regenerated from `schema/`, and
  `packages/lang-typescript/wasm/` is vendored from the
  `@vscode/tree-sitter-wasm` devDependency by that package's `build`. Both are
  gitignored; `wasm/` is also published, so it must exist before `pnpm pack`.

## Dependency updates

Dependabot proposes updates on Monday mornings, Japan time, grouped by
[`.github/dependabot.yml`](.github/dependabot.yml) so that what has to move
together arrives in one pull request and a major arrives on its own. A release
waits a week before it is proposed; security updates do not wait.
CI and the Aburi self-run treat these pull requests like any other, and some
need a hand before they merge:

- Biome changes its formatter output even in patch releases. Run `pnpm format`
  on the branch, and `pnpm exec biome migrate --write` to move the schema URL in
  `biome.json`. Its Markdown formatter stays off and `pnpm-workspace.yaml` stays
  out of its files: changesets writes every CHANGELOG, and pnpm and Dependabot
  write the catalog, each in a style the next check would flag.
- The workflow examples in the READMEs and under `docs/` use the same action
  versions as `.github/workflows/`; move them in the same pull request. A bump
  that reaches [`packages/github-action/action.yml`](packages/github-action/action.yml)
  changes what the action's users run and needs a changeset for
  `@aburi/github-action`.
- A change to a published package's `dependencies`, or to
  `@vscode/tree-sitter-wasm`, whose grammars `@aburi/lang-typescript` ships,
  needs a changeset like any other change to a published package; `minor` when
  the new grammars move a stored fingerprint. A catalog entry that a published
  package lists in `dependencies` counts, though its pull request touches only
  `pnpm-workspace.yaml` and the lockfile.

## Releases

Releases are cut from `main` via [changesets](https://github.com/changesets/changesets):
merging the release PR created by the release workflow publishes the packages
to npm, and that same run deploys the docs site (see above).

Publishing uses npm Trusted Publishing (OIDC), so no npm token exists anywhere. On npmjs.com every
`@aburi/*` package needs a trusted publisher entry for repository `aburi-dev/Aburi` and workflow
`.github/workflows/release.yml`, with no environment restriction. Renaming that workflow, or adding
an `environment:` to its job, breaks publishing until every entry is updated to match.

npm accepts a trusted publisher only for a package that already exists, so a new package is
published once by hand before the release PR that first versions it is merged:

1. From an account that can publish to the `@aburi` scope, publish a `0.0.0` that holds no code —
   a `package.json` with the package's name, license and `repository`, its `LICENSE`, and a README
   saying the version only reserves the name — with `npm publish <directory> --access public`.
   That leaves the first real version to the release workflow, which publishes it with provenance.
2. On the package's access page (`https://www.npmjs.com/package/@aburi/<name>/access`), add the
   trusted publisher above and allow **npm publish**. A new entry allows only `npm stage publish`,
   which `changeset publish` never runs.
3. Merge the release PR the same day: an entry that no publish uses within two days expires.
4. Once the release is out, deprecate `0.0.0` and the `0.0.0-stage` npm creates beside it.

Skip a step and the release run publishes every other package, fails on the new one, and skips
the docs deploy and the action tag.
