---
"@aburi/github-action": minor
---

Give the action a ref that can be pinned immutably.

`changeset publish` names every monorepo tag after its package, so the only ref a release
left behind for this action was `@aburi/github-action@0.2.0` — a name a `uses:` cannot
hold. The runner splits a `uses:` value on `@` and rejects anything that is not exactly
two segments, so `kage1020/Aburi/packages/github-action@@aburi/github-action@0.2.0` fails
the manifest to load with `Expected format {org}/{repo}[/path]@ref`, before any step runs.
That left `@main` as the only ref that worked, and `@main` changes under the consumer on
every merge. The action's own README recommended the per-package tag anyway.

Release runs now push two aliases onto the release commit:

- `action-v<x.y.z>`, created once and never moved, so a workflow pinned to it keeps
  running the bytes it was reviewed against. The step refuses to overwrite one that
  already exists rather than re-pointing it.
- `action-v<major>`, moved to the newest release in that major — the convenience alias,
  documented as mutable. While the major is `0` it crosses breaking input changes, because
  a `0.x` minor bump is where those land.

A release that bumps only the CLI or a plugin leaves both tags where they are, pointing at
the commit whose `action.yml` consumers are still running.

The READMEs and the CI integration guide gain a Pinning section covering all four refs
(`action-v<x.y.z>`, `action-v<major>`, `main`, a full SHA) and drop the advice that named
the unusable tag. `test/uses-refs.test.ts` replays the runner's own parse over every
`uses:` in the READMEs, the docs and the workflows, so a snippet that would fail to load
fails CI instead of a consumer's first run.
