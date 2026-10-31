---
"@aburi/cli": minor
---

`aburi diff <base>..<head>` runs its two scans at the same time: the base on a worker thread, the
head on the main thread. On a 4-CPU machine a diff of `nest`'s last 50 commits took 4.4 s instead of
6.9 s, and peak RSS rose from 362 MiB to 498 MiB. stdout, stderr, the exit code and the report stay
byte-identical to a run with one scan at a time. That includes which failure ends a run where a scan
fails: the base scan's error still comes first, and the head's log and incidents still follow the
base's.

The new `--concurrency <n>` option (`DiffOptions.concurrency`) caps how many scans run at once.
`--concurrency 1` restores the old order: the base, then the head. Without it, both scans run
together when `os.availableParallelism()` reports two or more CPUs.
