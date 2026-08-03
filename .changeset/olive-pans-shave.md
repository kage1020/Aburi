---
"@aburi/cli": patch
---

Discover `aburi.json` from `cwd`, not from the detected workspace root

`runScan` handed the marker-detected workspace root to `loadConfig`, so discovery could
only ever walk *upwards from the root*. A config below it — the normal case for a package
inside a monorepo — was never read. The run then fell through to autodetect, resolved no
language plugin, reported every file as unroutable, and wrote an empty IR at exit 0, which
silently makes every downstream `--fail-on` gate pass.

`--config` relative paths now resolve against `cwd` too, matching `--output-dir`,
`--base`, `--head` and `--ir`. The workspace root is unchanged: it stays marker-detected
and remains the base for Symbol id paths and for the config's own relative globs.
