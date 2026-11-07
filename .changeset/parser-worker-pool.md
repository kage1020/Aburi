---
"@aburi/core": minor
"@aburi/cli": minor
---

Extract files on a pool of parser worker threads, sized by `--concurrency`

`aburi scan`, and the scans `aburi diff` and `aburi explain` run, now extract their files on worker threads: one fewer than the processors by default, fewer when the free memory cannot hold each worker's declared `wasmHeapPerWorkerMB`, and none below 256 KiB of source for each worker, where starting one costs more than it saves. `--concurrency <n>` sets the count, and `--concurrency 1` keeps every file on the main thread. The two scans of `aburi diff` that run at once share the machine, each sized to half of it. On four processors a scan of Aburi's own 878 files goes from 6.0 s to 3.9 s.

The IR, the pages, the discovered-vocabulary record, the report, stdout, the exit code and stderr are byte for byte those of `--concurrency 1`, but for one `debug:` line naming the pool. Each file's log is said in file order, and a scan that stops at a file stops there as one thread does.

A worker that ends under a file — a plugin calling `process.exit()`, an error thrown from a timer, a worker out of memory — withdraws that file as a throw does (`extraction-failed`, code `extraction-thread-ended`) and the rest are extracted; the third worker to end ends the run with exit 1, and so does a worker that cannot load the scan's plugins. Each names `--concurrency 1`. Anything but a positive integer for `--concurrency`, or for `concurrency` passed to `runScan`, `runDiff` or `runExplain`, is refused at exit 2 before anything is read.

An import resolver's log lines are now said once per scan: the same line twice, from one resolver or from the one each worker creates, is said once.

`@aburi/core` exports what a pool is built from: `createFileExtractor`, which extracts any file of a scan by its index and answers with the file's outcome and what its extraction said, and `ScanInput.parsePool`, a `ParsePoolFactory` the scan hands its job to and folds the answers of in file order, extracting on its own thread when there is none or it answers `null`.
