---
"@aburi/diff": minor
"@aburi/cli": patch
---

`buildDiff` takes an optional `logger` and writes a `debug` line for each Symbol or pairing stage 4 refuses on a rule rather than a score: a name that says too little to pair on, a Symbol with no signature, and a pair the owner gate refused after it cleared its threshold. Each of these reaches the report as an added and a removed entry with no reason given, so a reviewer looking at the churn could not tell why the two were not paired. `aburi diff` passes the run's logger, so `--log-level debug` or `ABURI_LOG_LEVEL=debug` prints the lines on stderr. The diff result is the same with and without a logger.
