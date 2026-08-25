# CI integration

The point of running Aburi in CI is twofold: put the report where reviewers
will see it, and fail the build on changes that need a human.

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
      - uses: kage1020/Aburi/packages/github-action@main
        with:
          version: latest
          fail-on: "removed,dropped-toggled:to-dropped:>10"
```

The action diffs the pull request's base against its head and posts the report
as a comment. The comment carries a hidden marker, so every push rewrites the
same comment instead of adding another one.

| Input | Effect |
|---|---|
| `version` | Which `@aburi/cli` version to run (`latest`, `0.1.0`, …). |
| `fail-on` | Passed to `aburi diff --fail-on`. Empty means report only, never fail. |

::: warning `fetch-depth: 0` is required
Aburi checks out the base revision to analyse it, which a shallow clone cannot
do. Without this the run fails fast rather than producing a wrong diff.
:::

## Any other CI

The CLI has no opinion about your platform. Run it and read the exit code:

```bash
aburi diff "origin/${BASE_BRANCH}..HEAD" --fail-on 'removed,changed:>20'
```

- **`0`** — clean.
- **`3`** — a gate tripped, or the scan was too damaged to trust. Fail the build.
- **`2`** — your invocation is wrong (bad flag, malformed `--fail-on`). Fix the
  pipeline, not the code.

`out/diff.md` is the report; post it wherever your platform accepts Markdown.

When the `CI` environment variable is set, `aburi scan` drops the timestamp from
its output so identical commits produce identical bytes.

## Choosing a gate

Start narrow. A gate that fires on every pull request gets ignored within a week.

| Gate | Fires when |
|---|---|
| `removed` | Any symbol was deleted. Cheap and rarely noisy. |
| `api-changed` | A public signature or decorator changed. |
| `changed:>20` | An unusually large semantic change set. |
| `dropped-toggled:to-dropped:>10` | Many method bodies were emptied at once — the signature of a half-finished refactor. |

Combine them with commas; the first clause that fires ends the evaluation:

```bash
aburi diff main..HEAD --fail-on 'removed,changed:>20'
```

The full grammar is in the [CLI reference](/reference/cli#fail-on-grammar).
