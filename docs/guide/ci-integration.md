# CI integration

## GitHub Actions

The `@aburi/github-action` composite action runs `aburi diff` on the PR
base..head and upserts the Markdown report as a PR comment. The comment carries
a hidden marker, so every push rewrites the same comment in place — no comment
spam.

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

::: warning fetch-depth
`fetch-depth: 0` is required — `aburi diff` materialises the base ref with
`git worktree add`, and a shallow clone cannot resolve it. The CLI's
shallow-repo guard fails fast with a clear message instead of producing a wrong
diff.
:::

### Inputs

| Input | Effect |
|---|---|
| `version` | `@aburi/cli` version to run (e.g. `latest`, `0.1.0`). |
| `fail-on` | Passed through to `aburi diff --fail-on`. Empty means no gate. |

## Any other CI

The CLI is CI-agnostic. The contract is:

- Exit code `3` (`EXIT.GATE`) — a `--fail-on` clause triggered, or a plugin
  failed to load. Gate on this.
- Exit code `2` (`EXIT.INPUT_ERROR`) — configuration mistake (including a
  malformed `--fail-on` spec). Fix the pipeline.
- `out/diff.md` — the review-facing report, ready to post wherever your
  platform accepts Markdown.

```bash
aburi diff "origin/${BASE_BRANCH}..HEAD" --fail-on 'removed,changed:>20'
```

When the `CI` environment variable is set, `aburi scan` implicitly enables
`--no-timestamp` so IR bytes are reproducible across runs.

## Choosing a gate

Common starting points:

| Gate | Catches |
|---|---|
| `removed` | Any Symbol deleted — a strong review trigger. |
| `changed:>20` | Unusually large semantic change sets. |
| `dropped-toggled:to-dropped:>10` | Mass stubbing — e.g. a refactor that empties many method bodies. |
| `api-changed` | Any public-surface change. |

The full grammar (status tokens, directional subtypes, delta axes, `:>N`
thresholds) is in the [CLI reference](/cli-reference#fail-on-grammar).
