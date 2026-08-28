---
"@aburi/config": minor
"@aburi/cli": minor
---

Stop reporting Aburi's own faults, and the filesystem's, as a malformed config

Loading the config turned every thrown value into `config-error`, which `cli-spec.md` §9 spends
exit 2 on — the code that tells a reader to go and edit `aburi.json`. Two kinds of failure arrive
there that no edit fixes.

**Aburi's own invariants.** `formatAjvErrors` throws a bare `Error` when ajv reports failure with
an empty `errors[]`, and its own docblock says that means ajv is in an unexpected state rather
than the config being wrong. It reached the reader as `Failed to load Aburi config: ajv invariant
violation…` on exit 2. Anything that is not a `ConfigError` now exits 1 and says it is a bug in
Aburi, with where to report it — the same treatment `classifyDiffError` gives
`slice-invariant-violated`.

**A config that is there and cannot be read.** `config-read-failed` now exits 1 rather than 2. A
permission, a mount, or a directory named `aburi.json` is IO, and its message keeps the
`Failed to load Aburi config:` prefix, which names the phase that failed rather than who is
answerable for it.

Absence is no longer part of that code. `readConfigFile` stamped `config-read-failed` on every
read failure, `ENOENT` included, so a mistyped `--config ./typo.json` would have moved to exit 1
with it — where §9 lists "missing" under exit 2, because a path the reader named is theirs to
fix. `@aburi/config` gains **`config-not-found`** for that case, with the message `No config
file at <path>` rather than `Failed to read config at <path> (ENOENT)`, and the CLI keeps it on
exit 2. Only the explicit `--config` path raises it: discovery answers absence with `null` and
lets autodetect run, as before. `ENOENT`/`ENOTDIR` is now one set shared by the reader and the
prober, so the two cannot drift apart on what "nothing there" means.

The mapping is a switch that is total over `ConfigErrorCode`, so a code added upstream is a type
error rather than a silent arm. At runtime it degrades instead of throwing: `@aburi/config` and
`@aburi/cli` version independently, so a compiled switch can meet a code it never saw, and
throwing there would discard the message the reader needs. `classifyDiffError` had the same hole
and takes the same fix. Both now put the "report it" instruction on its own line, since nothing
reaching them ends in punctuation.

`classifyConfigError` is exported alongside `classifyDiffError`: it is where the two exit codes
are decided, and the branch that matters most is not otherwise reachable from a fixture.

Three commands read the config — `scan`, `diff` and `explain` — so all three inherit this;
`init` writes one and is unaffected. `cli-spec.md` §9 and §5.4 and `EXIT`'s own doc all state the
rule now, rather than three different ones.
