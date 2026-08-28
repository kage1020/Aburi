---
"@aburi/core": minor
"@aburi/cli": minor
---

Say which manifest declared packages and found none

A `packages:` list whose patterns matched no manifest reaches the same single-project fallback
as a manifest that declared no packages at all, and only the second wants it. The first is a
workspace whose every declared package is missing from the Document — from a mistyped pattern,
from a monorepo with no packages in it yet, or from packages whose manifest Aburi does not
recognize — and nothing said so.

The IR keeps no trace a reader can act on. `workspace.managers[].roots` comes back empty, which
is also what a `turbo.json` co-marker writes on purpose, so the two cannot be told apart from
the artifact.

`DetectManagersResult` now carries `unresolved`: one entry per **manifest** that declared package
patterns and resolved none, with its workspace-relative path and every string it listed. Per
manifest rather than per manager, because `pnpm-lock.yaml` beside a `package.json#workspaces`
makes both of a repository's manifests spell `pnpm` — the path is what a reader opens and what
orders two entries. `aburi scan` and `aburi init` name the manifest and the patterns on stderr,
and add a second line when nothing resolved anywhere and the whole repository was therefore
described as one component — not when `components[]` in the config decided them, since
detection's answer never reached the IR then.

A `packages:` key that is absent or holds an empty list is not a failed declaration: pnpm reads
both as "only the root package is included in the workspace", and so does this. Neither is
turbo, which declares no patterns, nor nx, which has no pattern list at all.

A `packages:` or `workspaces` that is present and is **not a list of strings** is now refused
with `workspace-manifest-malformed` naming the manifest and the offending entry, rather than
filtered away. A trailing colon on an entry — `- tools/*:`, which YAML reads as a map — is the
most ordinary slip there is, and it silently put every package the manifest declared on the
single-project fallback. pnpm refuses that shape, a bare scalar and a non-string element alike.

`ScanReport` gains `unresolvedDeclarations` and `fellBackToSingleComponent`; `InitReport` gains
the same two. Both are required, so external code assembling either needs the new fields —
`coverageFault` and `unrepresentableFiles` set the precedent for the minor bump.
