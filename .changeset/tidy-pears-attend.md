---
"@aburi/core": patch
---

Refuse the paths and qualified names that pass every check and then break something later

Two id-grammar holes let a value through the constructor and the integrity checker, and
surface as damage further down the pipeline.

**Paths that leave the workspace.** IR integrity invariant #10 carried its own copy of the
path rule and that copy had no `..` clause, so an IR whose `symbols[].source.file` read
`../../../../etc/passwd.ts` — or whose `components[].roots` / `workspace.managers[].roots`
pointed above the workspace — produced zero violations. `readIR` uses `assertIRIntegrity`
as its only validation gate, and `aburi diff --base <ir.json>` then resolves those paths
against the filesystem. Invariant #10 now calls the same `posixWorkspaceRelativeViolation`
the Symbol id constructor calls, so what Aburi writes and what it accepts are one set
rather than two implementations that had already drifted. The shared rule also covers an
empty path and a drive-relative `C:a.ts`, neither of which the old copy caught.

**Qualified names with empty segments.** `makeSymbolId` dropped empty segments before
validating them, so `A.`, `A..B`, `.` and `::` all built ids, satisfied `isSymbolId`, and
satisfied every invariant. The resulting Symbol then threw out of `apiFingerprint`, where
`lastQnameSegment` found the leaf empty — a producer-side defect surfacing four passes
away from its cause. The separators join two named constructs, so a segment between them
is now required to be a non-empty identifier, which is what `lastQnameSegment`'s contract
already assumed.

**Workspace roots outside the workspace.** Fixing invariant #10 exposed a producer that
could violate it: glob patterns may ascend (`packages: ['../shared/*']`), and the matches
became `workspace.managers[].roots` entries containing `..`. The file walk never followed
them — it globs under the workspace root — so those packages contributed no Symbol either
way, and the entry described a directory the scan never opened. Such candidates are now
dropped at detection, which removes the claim rather than the coverage. Workspace roots
are also normalized to Unicode NFC, matching `symbols[].source.file`, so the same
directory is not spelled two ways within one document.
