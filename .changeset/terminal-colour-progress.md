---
"@aburi/cli": minor
"@aburi/core": minor
---

Colour and a progress line on a terminal, `--no-color` and `--ci`

On a terminal, stderr colours warnings yellow, errors and tripped gates red and the log dim, and draws a progress line naming the phase of each scan (`discovering files…`, `extracting 412/5002 files`, `resolving calls…`; `base: … · head: …` and then `comparing…` under `aburi diff`). The line is redrawn in place, every other stderr line is written above it, and it is erased before the results are printed, so the terminal is left with what a pipe gets. stdout is never coloured.

Colour follows `--no-color`, then `FORCE_COLOR` (`0` or `false` turn it off), then `NO_COLOR`, then CI mode, then whether stderr is a terminal and `TERM` is not `dumb`. CI mode — `CI` set, or the new global `--ci` — draws no progress line, writes no colour unless `FORCE_COLOR` asks for it, and implies `aburi scan --no-timestamp`.

At `--log-level debug`, an error that ends the run with exit 1 or 3 is followed by its stack trace and those of its causes. The run's log now reaches the stderr `runCli` is given, as every other stderr line does, and `runScan`, `runDiff` and `runExplain` take `log` and `progress` callbacks.

`scan` in `@aburi/core` takes an `onProgress` callback, called with each `ScanProgress`: `discovering`, `extracting` with the files done and in all, then `resolving`.
