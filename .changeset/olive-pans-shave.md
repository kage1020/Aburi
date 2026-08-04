---
"@aburi/cli": minor
---

Discover `aburi.json` from `cwd`, not from the detected workspace root

`runScan` handed the marker-detected workspace root to `loadConfig`, so discovery could
only ever walk *upwards from the root*. A config below it — the normal case for a package
inside a monorepo — was never read. The run then fell through to autodetect, resolved no
language plugin, reported every file as unroutable, and wrote an empty IR at exit 0, which
silently makes every downstream `--fail-on` gate pass.

- `--config` **and `ABURI_CONFIG`** relative paths now resolve against `cwd`, matching
  `--output-dir`, `--base`, `--head`, `--ir`, `init --output` and `explain --output`. Both
  feed the same code path, so a CI job that exports a relative `ABURI_CONFIG` at the repo
  root and then changes directory reads a different file than before — if one exists there.
- `ScanReport` gains `configSource` and `workspaceRoot`. Once discovery starts at `cwd`,
  which config won is no longer deducible from the arguments.
- `aburi scan` warns on stderr when the config sits below the workspace root. Discovery is
  anchored to `cwd`, but everything inside the config — `ignore`, `components[].roots`,
  relative plugin refs — and file discovery itself are anchored to the workspace root, so a
  package-local `ignore: ["src/**"]` matches the *root's* `src` and the scan still covers
  the whole workspace.
