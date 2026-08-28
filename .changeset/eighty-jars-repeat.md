---
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

**A config that is there and cannot be read.** `config-read-failed` now exits 1 rather than 2.
It covers both a failing read of the config itself and a failing probe of a candidate while
discovery walks upward, so a permission, a mount, or a directory named `aburi.json` reports as
the IO it is. Its message keeps the `Failed to load Aburi config:` prefix, which names the phase
that failed rather than who is answerable for it.

The mapping is a switch that is total over `ConfigErrorCode`, so a code added upstream has to be
placed rather than defaulting into either arm. `classifyConfigError` is exported alongside
`classifyDiffError` for the same reason: it is where the two exit codes are decided.

Three commands read the config — `scan`, `diff` and `explain` — so all three inherit this;
`init` writes one and is unaffected.
