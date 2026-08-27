---
"@aburi/core": minor
"@aburi/cli": patch
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

`DetectManagersResult` now carries `unresolved`: one entry per manager whose manifest declared
package patterns and resolved none, with the patterns as written. `aburi scan` and `aburi init`
name the tool and the patterns on stderr, and add a second line when nothing resolved anywhere
and the whole repository was therefore described as one component — not when `components[]` in
the config decided them, since detection's answer never reached the IR then.

A `packages:` key that is absent or holds an empty list is not a failed declaration: pnpm reads
both as "only the root package is included in the workspace", and so does this. Neither is
turbo, which declares no patterns, nor nx, which has no pattern list at all.

`ScanReport` gains `unresolvedDeclarations` and `fellBackToSingleComponent`; `InitReport` gains
the same two.
