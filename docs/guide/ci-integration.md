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
      - uses: kage1020/Aburi/packages/github-action@main
        with:
          version: latest
          fail-on: "removed,dropped-toggled:to-dropped:>10"
```

The action diffs the pull request's base against its head and posts the report
as a comment. That comment carries a hidden marker, so every push rewrites it
in place instead of piling up a new one.

| Input | Effect |
|---|---|
| `version` | Which `@aburi/cli` version to run (`latest`, `0.1.0`, and so on). |
| `fail-on` | Passed to `aburi diff --fail-on`. Leave it empty to report without ever failing. |

::: warning `fetch-depth: 0` is required
Aburi checks out the base revision to analyse it, and a shallow clone cannot
give it one. Without the full history the run stops early rather than handing
you a wrong diff.
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

The [CLI reference](/reference/cli#fail-on-grammar) has the full grammar.
