---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/diff": patch
"@aburi/cli": patch
---

Brand `RelativePath`, so a path nothing checked cannot be written into the IR

`RelativePath` — the type of `symbols[].source.file`, `components[].roots[]` and `workspace.managers[].roots[]` — is now a branded string like `SymbolId` and `ComponentId`: it still reads as a `string`, but a bare `string` no longer satisfies it. `SourceFile.path`, the path a language plugin is handed, carries the brand, so a plugin that writes `ctx.file.path` back as `source.file` needs no change. A plugin that builds a path of its own mints one with `toDocumentPath` from `@aburi/core`, which now takes an optional subject to name the value in its refusal.

A language plugin whose candidate carries a `source.file` the path grammar refuses — a backslash, a `..` segment, an absolute path — now withdraws that file, recorded under `extractionFailures` with code `non-posix-path`, instead of failing the whole scan at the integrity check once every file was extracted.

In `@aburi/core`, `DiscoveredFile.path` and `WorkspaceCandidate.relativeRoot` are `RelativePath`. `stats.skippedFiles[].path` and `GitRenameMap` stay plain strings.
