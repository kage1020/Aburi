---
"@aburi/github-action": minor
---

Give the action a ref that can be pinned immutably.

`changeset publish` names every monorepo tag after its package, so the only ref a release
left behind for this action was `@aburi/github-action@<x.y.z>` — a name a `uses:` cannot
hold. The runner splits a `uses:` value on `@` and rejects anything that is not exactly
two segments, so `kage1020/Aburi/packages/github-action@@aburi/github-action@0.2.0` fails
the manifest to load with `Expected format {org}/{repo}[/path]@ref`, before any step runs.
That left `@main` as the only ref that worked, and `@main` changes under the consumer on
every merge. The action's own README recommended the per-package tag anyway.

A new `tag-action` job on the release workflow pushes two refs onto the release commit. They
are unprefixed — the path in front of them already says which action they belong to, and
`changeset publish` only ever writes scoped `@aburi/<pkg>@<ver>` tags, so the `v*` namespace
is this action's alone:

- `v<x.y.z>`, created once and never re-pointed, so a workflow pinned to it keeps
  running the bytes it was reviewed against. Pushing a tag only fails when it points
  somewhere else — on the same commit git reports `Everything up-to-date` and exits 0 — so
  the job compares the existing tag's commit itself: equal means a retried run and it
  carries on, different is an error naming the repair.
- `v<major>`, moved to the newest release of this action — the convenience alias,
  documented as mutable. While the major is `0` it crosses breaking input changes, because
  a `0.x` minor bump is where those land. A prerelease keeps its immutable tag and leaves
  the alias alone.

It is a separate job rather than a step on the publish job so that a tag ruleset or a
rejected push cannot redden a run in which npm already has the packages, or take the
`needs: release` docs deploy down with it. Because `changeset publish` skips packages that
are already published, a re-run reports `published: false` and could never reach the
tagging again, so the workflow also gains a `workflow_dispatch` that tags a given version
at the commit its `@aburi/github-action@<version>` tag names — a recovery path that cannot
start a publish, and does not depend on where `main` has moved since.

A release that bumps only the CLI or a plugin leaves both tags where they are, pointing at
the commit whose `action.yml` consumers are still running.

The READMEs and the CI integration guide gain a Pinning section covering all four refs
(`v<x.y.z>`, `v<major>`, `main`, a full SHA) and drop the advice that named
the unusable tag. Their examples move off `@main` onto `@v0`, which this release is
the first to create; the section says plainly that it crosses breaking input changes while
the major is `0`, and points anyone who minds at the full `v<x.y.z>`.

The companion workflow's checkout in the fork hand-off example pins `ref: v0` rather
than a hard-coded `@aburi/github-action@<x.y.z>`. `changeset version` rewrites `package.json`
and `CHANGELOG.md` and nothing else, so a version written into README prose goes stale on the
next release with nothing to catch it; the alias has no version to keep in step.

`test/uses-refs.test.ts` replays the runner's own parse over every `uses:` in the READMEs,
the docs and the workflows — both quoting styles and a trailing comment included — so a
snippet that would fail to load fails CI instead of a consumer's first run. It also pins
the parse and the allowed-ref pattern with direct cases, checks the documented alias
against this package's real major (a `major` bump would strand every `@v0` in the
docs), and asserts the tagging job's gate, its separation from the docs deploy, and the
glob pattern that keeps the alias off a prerelease.

`turbo.json` declares the files that test reads as inputs of `@aburi/github-action#test`.
Without them a local run after editing the root README or the CI guide served a cached
pass and the new guard never executed; CI is cold every time, so it only ever bit locally.
