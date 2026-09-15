# @aburi/github-action

Composite GitHub Action that runs `aburi diff` on a pull request and upserts the
semantic-diff Markdown as a hidden-marker PR comment. `@aburi/cli` is either fetched
with `pnpm dlx @aburi/cli@<version>`, so consumers pin the CLI version rather than this
action's tag, or taken from the project's own install — see [Choosing `cli`](#choosing-cli).

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
| `version` | `latest` | npm dist-tag or exact version of `@aburi/cli`. `cli: dlx` only. |
| `refspec` | *(empty)* | `<base>..<head>` passed to `aburi diff`. Falls back to the PR's `base.sha..head.sha` for `pull_request` / `pull_request_target` events. |
| `fail-on` | *(empty)* | Forwarded to `--fail-on`; see `docs/design/cli-spec.md` §6.7 for the grammar. Empty = report only. |
| `config` | *(empty)* | Path to `aburi.json` / `aburi.config.jsonc`. |
| `output-dir` | `out` | Where the CLI writes `diff.json` / `diff.md`, relative to `working-directory`. Always forwarded to `--output-dir`, because the action reads `diff.md` back to post it — so `config.output.dir` never applies here, and a workspace that sets it must set this input to match. |
| `format` | `both` | `json` / `md` / `both`. Must include Markdown when `comment: true`. |
| `working-directory` | `.` | Directory to run the CLI from. |
| `cli` | `dlx` | How the CLI is resolved: `dlx` (`pnpm dlx @aburi/cli@<version>`) or `workspace` (the `@aburi/cli` your project installed). See [Choosing `cli`](#choosing-cli). |
| `comment` | `true` | Upsert the produced Markdown as a PR comment. |
| `token` | `${{ github.token }}` | Token used for the comment API. |
| `node-version` | `24` | Node.js version installed via `actions/setup-node`. `cli: dlx` only. |
| `pnpm-version` | `10` | pnpm version installed via `pnpm/action-setup`. `cli: dlx` only. |

## Outputs

| Output | Meaning |
|---|---|
| `diff-json-path` | Path to `diff.json` (empty when `format=md`). |
| `diff-md-path` | Path to `diff.md` (empty when `format=json`). |
| `cli-exit-code` | `0` clean · `1` runtime error · `2` input error · `3` `--fail-on` gate or plugin error. Matches [`packages/cli/src/exit-codes.ts`](../cli/src/exit-codes.ts). Also `2` when `cli: workspace` finds no CLI to run. |
| `comment-id` | Numeric id of the created/updated comment (empty when `comment=false`). |
| `comment-action` | `created` / `updated` / `unchanged`. |

## Choosing `cli`

`dlx` needs no install step, and cannot load a plugin your config names **by package**.
`pnpm dlx` puts `@aburi/cli` in the pnpm store, and the CLI resolves plugin refs from its
own location — so `languages: ["lang-typescript"]` fails there with `Cannot find package
'@aburi/lang-typescript'`, whatever your project has installed. A ref written as a relative
path (`./plugins/x.mjs`) resolves against your workspace root and works fine.

`workspace` runs the `@aburi/cli` your project installed, resolved from `working-directory`,
with its plugins beside it — the install the [quick start](../../README.md#quick-start)
prescribes. Install the workspace first (and build it, if the CLI comes from source);
`version`, `node-version` and `pnpm-version` do not apply, because the toolchain that
installed the workspace is the one that should run it.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: pnpm/action-setup@v4
  with:
    version: 10
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

Resolution goes through Node's resolver rather than a `node_modules/.bin` entry, so npm, yarn
and bun projects work the same way, as does a workspace that builds the CLI from source and
therefore has no bin link at all. The exception is **Yarn PnP**, which has no `node_modules`
and needs `yarn node` to load `.pnp.cjs`: `cli: workspace` exits 2 there. Anything it cannot
resolve is exit 2 with a message naming the directory it looked in —
[`docs/design/github-action.md`](../../docs/design/github-action.md) §3 has the details.

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

## Pull requests from a fork

A `pull_request` run started by a fork — and by Dependabot, whose branch lives inside the
repository — gets a read-only `GITHUB_TOKEN` whatever the workflow's `permissions` block says,
so the comment cannot be posted from there. `pull_request_target` is not the answer: it would
run with a writable token while `aburi diff` analyses code the contributor controls.

Post it from a second workflow instead. The first uploads the report; the second runs on
`workflow_run`, in the base repository's context, and comments.

```yaml
# .github/workflows/aburi.yml
name: Aburi
on: pull_request

jobs:
  diff:
    runs-on: ubuntu-latest
    env:
      # Tells the action not to try on a fork's pull request or Dependabot's, where the token is
      # read-only whatever `permissions:` says. The hand-off below keys on the *outcome*, not on
      # this — see the comment there.
      CAN_COMMENT: >-
        ${{ github.event.pull_request.head.repo.full_name == github.repository
            && github.actor != 'dependabot[bot]' }}
    steps:
      # …checkout, install, build…
      - uses: kage1020/Aburi/packages/github-action@main
        id: aburi
        with:
          cli: workspace
          # `false` on a fork's pull request and Dependabot's; the diff and the gate still run.
          comment: ${{ env.CAN_COMMENT }}
      # The companion posts when this file is in the artifact and exits when it is not, so the
      # decision lives in one place instead of being written twice, in two event shapes.
      #
      # `comment-id` is empty both when the action was told not to comment and when it tried and
      # was refused — a 403, a rate limit, a `fetch failed`. Keying on `CAN_COMMENT` instead would
      # leave that second case with no marker, and the companion would read the absence as "a
      # comment is already there". The exit-code arm is the action's own comment gate: 1 and 2 mean
      # a report that is missing or partial.
      - name: Hand the comment to the companion workflow
        if: >-
          always() && hashFiles('out/diff.md') != ''
          && steps.aburi.outputs.comment-id == ''
          && (steps.aburi.outputs.cli-exit-code == '0' || steps.aburi.outputs.cli-exit-code == '3')
        run: echo "posted by the companion" > out/comment-pending
      - uses: actions/upload-artifact@v4
        if: always() && hashFiles('out/diff.md') != ''
        with:
          name: aburi-diff
          path: out/
```

The companion runs on `workflow_run`, checks out **this repository** for the upsert script — not
yours; a plain `actions/checkout@v4` would give you your own tree and the last step would fail on
a module that is not there — downloads the artifact from the run that triggered it, resolves the
pull request **from the event** rather than from the artifact, and posts:

```yaml
# .github/workflows/aburi-comment.yml
on:
  workflow_run:
    # Matches the analysis workflow's `name:`, not its filename.
    workflows: [Aburi]
    types: [completed]

permissions:
  contents: read
  actions: read
  pull-requests: write

jobs:
  comment:
    if: github.event.workflow_run.event == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      # Third-party code in the half that holds a writable token, so pin the ref: a tag or a
      # commit SHA, never a moving branch.
      - uses: actions/checkout@v4
        with:
          repository: kage1020/Aburi
          ref: "@aburi/github-action@0.2.0"
          sparse-checkout: packages/github-action/scripts
          persist-credentials: false
      # …download the aburi-diff artifact from github.event.workflow_run.id, resolve the pull
      # request from the event, then…
      - env:
          GITHUB_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ steps.pr.outputs.number }}
          MARKDOWN_PATH: report/diff.md
        run: node packages/github-action/scripts/upsert-comment.mjs
```

[`.github/workflows/aburi-comment.yml`](../../.github/workflows/aburi-comment.yml) is Aburi's own
working copy, with the artifact lookup and the pull-request resolution written out — read it as a
reference rather than copying it, since its checkout takes the script from the repository the
workflow lives in, which for you is not this one.
[`docs/design/github-action.md`](../../docs/design/github-action.md) §5.1 explains what makes it
safe to give that half a writable token. Two things to know: GitHub runs the copy of a
`workflow_run` workflow that is on your **default branch**, so it does nothing until it is merged,
and it posts no check on the pull request.

### Posting the comment yourself

`scripts/upsert-comment.mjs` is plain `.mjs` with no dependencies, so anything with Node can run
it — including a job that installs nothing, which is how the companion above uses it: the script
is checked out from this repository, not resolved from `node_modules`. (It also ships in the npm
tarball, for a job that does have the package installed.) Input is environment only:

| Variable | |
|---|---|
| `GITHUB_TOKEN` | Token that may comment on the pull request. |
| `GITHUB_REPOSITORY` | `owner/repo`, as the runner already sets it. |
| `PR_NUMBER` | The pull request to comment on. |
| `MARKDOWN_PATH` | The report to post. |
| `GITHUB_API_URL` | Optional; the runner sets it, and Enterprise Server needs it. |
| `GITHUB_OUTPUT` | Optional; `action` and `comment-id` are appended when set. |

Exit `0` posted, `2` the invocation is wrong, `1` the API refused — each failure one
`::error::` line.

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
