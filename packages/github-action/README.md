# @aburi/github-action

Composite GitHub Action that runs `aburi diff` on a pull request and upserts the
semantic-diff Markdown as a hidden-marker PR comment. The `@aburi/cli` binary is
resolved through `pnpm dlx @aburi/cli@<version>`, so consumers pin the CLI version
rather than this action's tag.

## Usage

```yaml
name: aburi-diff
on:
  pull_request:
    branches: [main]

jobs:
  aburi:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      # Pin by branch (main) or by the per-package tag `changesets/action`
      # creates on release (e.g. `@aburi/github-action@0.1.0`). An unscoped
      # `vX.Y.Z` tag is intentionally not published because `changeset publish`
      # names monorepo tags per package.
      - uses: kage1020/Aburi/packages/github-action@main
        with:
          version: latest
          fail-on: "removed,dropped-toggled:to-dropped:>10"
```

`fetch-depth: 0` is required so `aburi diff` can resolve the base ref locally.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `version` | `latest` | npm dist-tag or exact version of `@aburi/cli`. |
| `refspec` | *(empty)* | `<base>..<head>` passed to `aburi diff`. Falls back to the PR's `base.sha..head.sha` for `pull_request` / `pull_request_target` events. |
| `fail-on` | *(empty)* | Forwarded to `--fail-on`; see `docs/design/cli-spec.md` §6.7 for the grammar. Empty = report only. |
| `config` | *(empty)* | Path to `aburi.json` / `aburi.config.jsonc`. |
| `output-dir` | `out` | Where the CLI writes `diff.json` / `diff.md`, relative to `working-directory`. Always forwarded to `--output-dir`, because the action reads `diff.md` back to post it — so `config.output.dir` never applies here, and a workspace that sets it must set this input to match. |
| `format` | `both` | `json` / `md` / `both`. Must include Markdown when `comment: true`. |
| `working-directory` | `.` | Directory to run the CLI from. |
| `cli` | `dlx` | How the binary is resolved: `dlx` (`pnpm dlx @aburi/cli@<version>`) or `workspace` (`pnpm exec aburi`, the CLI your project installed). |
| `comment` | `true` | Upsert the produced Markdown as a PR comment. |
| `token` | `${{ github.token }}` | Token used for the comment API. |
| `node-version` | `24` | Node.js version installed via `actions/setup-node`. |
| `pnpm-version` | `10` | pnpm version installed via `pnpm/action-setup`. |

## Outputs

| Output | Meaning |
|---|---|
| `diff-json-path` | Path to `diff.json` (empty when `format=md`). |
| `diff-md-path` | Path to `diff.md` (empty when `format=json`). |
| `cli-exit-code` | `0` clean · `1` runtime error · `2` input error · `3` `--fail-on` gate or plugin error. Matches [`packages/cli/src/exit-codes.ts`](../cli/src/exit-codes.ts). |
| `comment-id` | Numeric id of the created/updated comment (empty when `comment=false`). |
| `comment-action` | `created` / `updated` / `unchanged`. |

## Choosing `cli`

`dlx` needs no install step, and cannot load plugins. `pnpm dlx` puts `@aburi/cli`
in the pnpm store, and Node resolves a config's plugin refs from the CLI's own
location — so a config that names `languages: ["lang-typescript"]` fails there with
`Cannot find package '@aburi/lang-typescript'`, whatever your project has installed.
It fits a workspace whose config names no plugin.

`workspace` runs `pnpm exec aburi` from `working-directory`, so the binary and its
plugins come from your `node_modules` — the install the [quick
start](../../README.md#quick-start) prescribes. Install and build the workspace first;
`version`, `node-version`, and `pnpm-version` are ignored, because the toolchain that
installed the workspace is the one that should run it.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: pnpm
- run: pnpm install --frozen-lockfile
- uses: kage1020/Aburi/packages/github-action@main
  with:
    cli: workspace
    fail-on: "removed"
```

This repository runs itself that way; [`.github/workflows/aburi.yml`](../../.github/workflows/aburi.yml)
is the whole file.

## Behaviour

- The comment is located by the hidden marker `<!-- aburi:diff-comment -->`. Subsequent
  runs of the same workflow update the same comment instead of piling new ones on the PR.
- When the produced Markdown matches the existing comment byte-for-byte the action reports
  `unchanged` and skips the PATCH request — this keeps notification noise low for
  no-op re-runs.
- A triggered `--fail-on` gate makes the step exit with the CLI's exit code (`3`),
  which fails the PR check while still leaving the comment on the PR for the reviewer.
- The comment step is skipped when the CLI exits with `1` (runtime error) or `2`
  (input error) so a missing `diff.md` cannot bury the real failure inside a
  secondary `ENOENT` from the comment upsert.

## Programmatic API

The same upsert primitive is exported as a library for callers who want to post
Aburi-style diff comments without the full action:

```ts
import { upsertPullRequestComment } from "@aburi/github-action"

await upsertPullRequestComment({
  ref: { owner: "kage1020", repo: "Aburi", pullNumber: 42 },
  body: "…markdown produced by aburi diff…",
  token: process.env.GITHUB_TOKEN!,
})
```
