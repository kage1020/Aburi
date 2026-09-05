---
"@aburi/cli": minor
"@aburi/config": minor
---

`aburi diff` scans the base revision with the head's config, as the spec always said it did

`cli-spec.md` §6.4 step 3 requires the base scan to read the **head**'s `aburi.json`, because
a base read through its own config makes "config change" and "the entire IR changed" the same
event. The implementation did the opposite. `runScanInDir` handed the base scan a cwd inside
the temporary worktree, and config discovery walks up from cwd — so a commit that edited
nothing but `ignore` reported the Symbols that setting covers as added or removed:

```
$ aburi diff HEAD~1..HEAD --fail-on added
+1 -0 ~0 ↔0 ⤴0
--fail-on added tripped (observed: 1 added)
EXIT=3
```

`--config` was not an escape, and neither was `ABURI_CONFIG`: both arrive as one value that
resolves against the scan's cwd, so a relative path named the base revision's copy of the file
for the base scan and the head's for the head scan — the same defect wearing a flag.

Both routes are now settled once, before the worktree exists, and both scans are handed that
one answer. `pinConfig(cwd, overridePath)` returns a `ConfigSource` — an absolute path, or
`autodetect` — and `loadPinnedConfig` reads it wherever the working directory has since moved
to. `runScan` spends whichever it was given: `options.pinnedConfig ?? (await pinConfig(cwd,
options.configPath))`, so the precedence between a decided config and one still to decide is
the operator rather than a sentence.

`autodetect` is carried rather than left implicit, because the defect is symmetric: a head
revision with no config on disk must not send the base scan back to discovery, where the base
ref's own `aburi.json` is waiting. Today both sides then stop on "no language plugin is
configured" rather than producing an IR, so what this buys is that they stop *identically* —
the guarantee only starts paying out when autodetect can reach a plugin set of its own.

Two things the pinning exposed, fixed here rather than left for a reader to trip over:

- **A relative plugin ref in the head's config was resolved inside the base worktree**, so a
  commit that added `./plugins/new.mjs` and registered it made the base scan die on a config
  the head reads fine. §6.4.1.5 pins the plugin set to the head environment — the worktree
  materialises sources only, `node_modules` is the caller's — so the ref resolves there too.
  `ScanOptions.pluginRefRoot` carries it; everything else inside the config (`ignore`,
  `components[].roots`) still resolves against each scan's own workspace root, because those
  name sources and the worktree is where the base's sources are.
- **The "config sits below the workspace root" warning fired on every ref-mode diff.** It
  compares the config's directory against the workspace root, which for a pinned base scan can
  never match — the head's `aburi.json` is not below the worktree, it is in another tree, and
  nobody ran anything from a monorepo package. `ScanReport.configPinnedByCaller` exempts it,
  and the half of the sentence that stays true moves into the `aburi diff` section of the CLI
  reference, where a reader meets it once instead of on every run.

`@aburi/config` gains a `ConfigSource` union and `loadConfigFrom` / `configSourceFrom`, so a
caller that has already chosen a file can say so without rebuilding the `LoadedConfig` shape.
The input side is discriminated the way `LoadedConfig.found` already discriminates the output
side: `loadConfigFrom(null)` would read as "read from the default", which is the opposite of
what it would have meant.

`@aburi/cli` gains `ScanOptions.pinnedConfig`, `ScanOptions.pluginRefRoot`,
`ScanReport.configPinnedByCaller`, and the `pinConfig` / `loadPinnedConfig` / `PinnedConfig`
exports. `loadPinnedConfig` rejects a relative path outright, since the whole contract is that
the answer no longer depends on where the process is standing. Nothing changes for a caller
that sets none of the new fields.
