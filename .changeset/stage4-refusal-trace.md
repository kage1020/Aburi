---
"@aburi/diff": minor
"@aburi/cli": patch
---

`buildDiff` takes an optional `logger`, and `matchStageNameSignature` takes one as an optional third argument. Given one, the name-and-signature stage of the matcher writes a `debug` line for each Symbol it will not compare by name, because its name says too little to pair on or it has no signature. Once it has chosen its pairings, it also writes one for each pair whose base and head both stay unpaired, that cleared its threshold, and whose owners do not correspond. A Symbol line stands for one `added`, `removed` or `unknown` entry, and a pair line for two Symbols the report lists separately, where the report itself gives no reason. The diff result is the same with and without a logger. `aburi diff` passes one at `--log-level debug` or `ABURI_LOG_LEVEL=debug`, which prints the lines on stderr, and the `--log-level` help now says so.
