---
"@aburi/cli": minor
---

`ABURI_LOG_LEVEL` now governs the scans `aburi diff` and `aburi explain` run, as it already governed `aburi scan`'s. Both commands built their scans without it, so those scans logged at `warn` whatever the variable said: `ABURI_LOG_LEVEL=error aburi diff main..HEAD` still printed a `warn: Skipped src/legacy.ts: parse reported a non-recoverable error at 12:4 — …` line from each side, and `ABURI_LOG_LEVEL=debug` reached neither command's per-file `debug:` lines. `runDiff` and `runExplain` take the level as `logLevel`, as `runScan` does.

The level can also be set with `--log-level debug|info|warn|error`, on any command and before or after it, and the flag wins over the variable. A value other than those four exits 2, where the variable still ignores one. The default stays `warn`. Every command's `--help` lists the flag among its global options.

The level decides only which `debug:`, `info:`, `warn:` and `error:` lines reach stderr. The `⚠` warnings, the IR, `diff.json` and `diff.md` are the same at every level, so nothing produced before this release compares differently with what is produced after.

Minor rather than patch: the CLI gains a flag, and `DiffOptions` and `ExplainOptions` gain `logLevel`.
