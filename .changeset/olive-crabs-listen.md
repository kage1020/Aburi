---
"@aburi/cli": patch
"@aburi/config": minor
---

`aburi diff` scans the base revision with the head's config, as the spec always said it did

`cli-spec.md` §6.4 step 3 requires the base scan to read the **head**'s `aburi.json`, because
a base read through its own config makes "config change" and "the entire IR changed" the same
event. The implementation did the opposite. `runScanInDir` handed the base scan a cwd inside
the temporary worktree, and `resolveConfig` discovers from cwd — so a commit that edited
nothing but `ignore` reported the Symbols that setting covers as added or removed:

```
$ aburi diff HEAD~1..HEAD --fail-on added
+1 -0 ~0 ↔0 ⤴0
--fail-on added tripped (observed: 1 added)
EXIT=3
```

`--config` was not an escape. Its value resolves against the scan's cwd too, so a relative
path named the base revision's copy of the file for the base scan and the head's for the head
scan — the same defect wearing a flag.

Both routes are now settled once, before the worktree exists, and both scans are handed that
one answer. `pinConfig(cwd, overridePath)` returns a `PinnedConfig` — an absolute path, or
`autodetect` — and `loadPinnedConfig` reads it wherever the working directory has since
moved to. `resolveConfig` is the two composed, so discovery's precedence has one definition
and every command still gets it.

`autodetect` is carried rather than left implicit, because the defect is symmetric: a head
revision with no config on disk has to scan the base by autodetect too, even when the base
ref still carries an `aburi.json`. Omitting the field would send that scan back to discovery
and reintroduce the bug for the one commit that deletes a config.

`@aburi/config` gains `loadConfigFrom(source: string | null)` — the second half of
`loadConfig`, exported so a caller that has already chosen a file does not have to
reconstruct the `LoadedConfig` shape to use it. `loadConfig` is now that function applied to
`findConfig`'s answer, so there is still one place that builds it.

`ScanOptions` gains `pinnedConfig`, which supersedes `configPath` and discovery both. Nothing
else changes for a caller that does not set it.
