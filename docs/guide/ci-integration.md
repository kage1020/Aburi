# CI integration

Running Aburi in CI does two things: it puts the report where reviewers will see
it, and it fails the build on changes that need a human.

## GitHub Actions

```yaml
name: Aburi
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  aburi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: kage1020/Aburi/packages/github-action@v0
        with:
          version: latest
          fail-on: "removed,dropped-toggled:to-dropped:>10"
```

The action diffs the pull request's base against its head and posts the report
as a comment. That comment carries a hidden marker, so every push rewrites it
in place instead of piling up a new one.

| Input | Effect |
|---|---|
| `version` | Which `@aburi/cli` version to run (`latest`, `0.1.0`, and so on). Applies to `cli: dlx`. |
| `fail-on` | Passed to `aburi diff --fail-on`. Leave it empty to report without ever failing. |
| `cli` | How the binary is resolved: `dlx` (default) or `workspace`. See below. |
| `max-bytes` | Size cap for the report, in bytes. Defaults to what a GitHub comment holds; see below. |

::: tip A large pull request still gets a comment
GitHub refuses a comment body over 65536 bytes, which is about 310 added symbols' worth of
report. The action renders to fit rather than being refused: whole sections are dropped from the
least important end — Syntax-only first, API changes last — and a note at the top names them.
`diff.json` keeps everything. Pass `max-bytes: 0` to turn the cap off.
:::

::: warning `fetch-depth: 0` is required
Aburi checks out the base revision to analyse it, and a shallow clone cannot
give it one. Without the full history the run stops early rather than handing
you a wrong diff.
:::

### Pinning the action

`@v0` above moves to the newest `0.x` release of the action, so a breaking input
change arrives without you asking for it; `@main` changes on every merge. Pin the full
`@v<x.y.z>` — created once by the release, never re-pointed — when you want to keep
running the bytes you reviewed, or a full commit SHA when you would rather not trust that a
tag was never moved.

Which refs exist, what each one costs you, and why the `@aburi/github-action@<x.y.z>` tag in
this repository is not one of them, are in
[the action's Pinning section](https://github.com/kage1020/Aburi/blob/main/packages/github-action/README.md#pinning).

### Running the CLI your project installed

By default the action fetches the CLI with `pnpm dlx`, which needs no install step and puts
`@aburi/cli` in the pnpm store rather than in your checkout. The CLI resolves plugin refs
from its own location, so a config naming a plugin **by package** —
`languages: ["lang-typescript"]`, which is what `aburi init` writes — fails there with
`Cannot find package '@aburi/lang-typescript'`, no matter what your project has installed.
A plugin named by relative path (`./plugins/x.mjs`) resolves against your workspace root and
is fine either way.

Set `cli: workspace` and the action runs the `@aburi/cli` in your own `node_modules`
instead, plugins beside it — the install [Getting started](./getting-started.md) walks
through. Install the workspace first; `version` then has nothing to pin, because your
lockfile already pinned it.

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: pnpm/action-setup@v4
  with: { version: 10 }
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: pnpm
- run: pnpm install --frozen-lockfile
- uses: kage1020/Aburi/packages/github-action@v0
  with:
    cli: workspace
    fail-on: "removed"
```

The CLI is located with Node's own resolver rather than a `node_modules/.bin` entry, so npm,
yarn and bun projects work the same way, as does a workspace that builds the CLI from source.
Yarn PnP is the exception — it has no `node_modules`, and `.pnp.cjs` loads through `yarn node`
— so `cli: workspace` exits 2 there.

Aburi analyses its own pull requests this way, with the CLI each pull request builds:
[`.github/workflows/aburi.yml`](https://github.com/kage1020/Aburi/blob/main/.github/workflows/aburi.yml).

### Pull requests from a fork

A pull request opened from a fork runs with a read-only `GITHUB_TOKEN`, whatever your
`permissions:` block says — and so does Dependabot's, whose branch is in your repository
but whose token is not. The diff and the gate run normally there; the comment is the part
that cannot be posted, because posting it needs write access the run does not have.

The first thing to do is stop the action trying. Left at its default of `comment: true`, the
upsert gets a 403 and the check goes **red** on a pull request whose only fault is coming
from a fork:

```yaml
jobs:
  aburi:
    runs-on: ubuntu-latest
    env:
      CAN_COMMENT: >-
        ${{ github.event.pull_request.head.repo.full_name == github.repository
            && github.actor != 'dependabot[bot]' }}
    steps:
      # …checkout with fetch-depth: 0…
      - uses: kage1020/Aburi/packages/github-action@v0
        with:
          comment: ${{ env.CAN_COMMENT }}
          fail-on: "removed"
```

That is enough on its own: the report is then the `aburi-diff` artifact on the run, for
anyone who goes looking. To get the comment as well, split the work in two. The pull
request's own run uploads the report as an artifact and leaves a marker saying it posted
nothing; a second workflow, triggered on `workflow_run`, downloads both and posts the comment
with your repository's token — without checking out, or running, anything from the fork.

Reaching for `pull_request_target` instead is the wrong trade: it would give a writable token
to a job that analyses code the contributor wrote.

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
```

Both halves in full — the upload, the marker that hands the comment over, and the companion's
own steps — are in
[the action's README](https://github.com/kage1020/Aburi/tree/main/packages/github-action#pull-requests-from-a-fork).
Aburi runs that pair on itself
([`aburi.yml`](https://github.com/kage1020/Aburi/blob/main/.github/workflows/aburi.yml) and
[`aburi-comment.yml`](https://github.com/kage1020/Aburi/blob/main/.github/workflows/aburi-comment.yml)),
and [`docs/design/github-action.md`](../design/github-action.md) §5.1 walks through what makes
it safe to give the second half a writable token.

::: warning A `workflow_run` workflow runs from your default branch
GitHub always uses the copy on the default branch, so the companion does nothing until it is
merged — including on the pull request that adds it. It also posts no check on the pull
request: the comment appearing is the signal, and failures show in the Actions tab.
:::

## Any other CI

The CLI has no opinion about your platform. Run it and read the exit code.

| Code | Meaning | What to do |
|---|---|---|
| `0` | Clean. | Nothing. |
| `3` | A gate tripped, or the scan was too damaged to trust. | Fail the build. |
| `2` | Your invocation is wrong: bad flag, malformed `--fail-on`. | Fix the pipeline. |

```bash
aburi diff "origin/${BASE_BRANCH}..HEAD" --fail-on 'removed,changed:>20'
```

`out/diff.md` is the report. Post it wherever your platform takes Markdown.

Set the `CI` environment variable and `aburi scan` drops the timestamp from its
output, so identical commits produce identical bytes.

## Choosing a gate

Start narrow. A gate that fires on every pull request gets ignored within a week.

| Gate | Fires when |
|---|---|
| `removed` | Somebody deleted a symbol. Cheap, and rarely noisy. |
| `api-changed` | A public signature or decorator changed. |
| `changed:>20` | The semantic change set is unusually large. |
| `dropped-toggled:to-dropped:>10` | Somebody emptied many method bodies at once, the signature of a half-finished refactor. |

Combine them with commas. The first clause that fires ends the evaluation.

```bash
aburi diff main..HEAD --fail-on 'removed,changed:>20'
```

The [CLI reference](../reference/cli.md#fail-on-grammar) has the full grammar.
