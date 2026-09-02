# Public-repository benchmark

Runs `aburi scan` and `aburi diff` against pinned commits of nine public
repositories and records both what it cost and what it produced.

The synthetic corpus in [`docs/design/performance.md`](../../docs/design/performance.md)
§2 measures one shape deliberately: 1,200 similar small files, which is the shape
the planned worker pool exists for. Public repositories measure the shapes nobody
designs for — a generated file thousands of lines long, a workspace Aburi splits
into 113 components, a wall of `.tsx`, decorators on every class — and they are
the only way to find out whether Aburi extracts anything sensible from code it
has never seen. So the two benchmarks answer different questions and neither
replaces the other.

Every repo therefore yields two kinds of number:

- **Cost** — wall time, peak RSS, files per second.
- **Outcome** — files parsed, symbols kept and dropped, calls resolved, files
  lost and why. A scan that skips half the workspace is fast for the wrong
  reason, and the timing column alone cannot say so.

## Running it

```bash
pnpm build                                  # the harness runs the built CLI
node benchmarks/public-repos/run.mjs        # every repo, 1 warmup + 3 measured runs
```

| Flag | Meaning |
|---|---|
| `--only <ids>` | Comma-separated repo ids from `repos.json` |
| `--runs <n>` | Measured scan runs per repo (default 3; the report quotes the median) |
| `--warmup <n>` | Discarded runs before measuring (default 1 — the first run pays the page-cache miss) |
| `--no-diff` | Skip the `aburi diff base..head` measurement |
| `--work-dir <path>` | Where clones live (default `$TMPDIR/aburi-bench-work`) |

Every flag value is checked before the build and the clones are paid for, and an
`--only` id `repos.json` does not carry is an error rather than a filter: a sweep
that quietly measured one repository where two were asked for is not the sweep in
the report header.

Results land in `results/<date>.json` (every sample and every counter) and
`results/<date>.md` (the tables worth reading), rewritten after each repository
rather than once at the end.

The work directory must sit **outside** this repository. A clone below it
inherits Aburi's own `pnpm-workspace.yaml` as its workspace root, and the scan
then measures the wrong tree; the harness refuses rather than reporting that
number.

The first run fetches ~125 MB and leaves a ~760 MB work directory once the
nine trees are checked out. Clones are `--filter=blob:none`
rather than `--depth 1` because `aburi diff` refuses a shallow repository — it
needs the base ref's history — while a partial clone keeps every commit and
fetches only the blobs a checkout touches. Reruns reuse the clones.

## What the harness does per repo

1. Check the clone out at the pinned `head`, and `git clean -xfd` it — keeping
   `out/` and `aburi.json`, which are the harness's own and have to outlive the
   checkout.
2. Run `aburi init` (measured) and keep what it detected.
3. Rewrite the detected plugin refs to `file://` URLs for this checkout's built
   plugins. A benchmark clone has no `node_modules`, and installing the workspace
   into nine unrelated repositories would cost more than the measurement and risk
   measuring a published version instead of the working tree.
4. Run `aburi scan --no-timestamp` `--warmup` + `--runs` times, removing the IR
   before each run and hashing the one each measured run wrote.
5. Read the IR for the outcome counters.
6. Run `aburi diff <base>..<head>` once, with `--config` pointing at the
   rewritten config — the base ref is scanned inside a throwaway `git worktree`
   where the harness's untracked `aburi.json` does not exist, and without it the
   base scan aborts with `No language plugin is configured` (exit 2).

Each measurement runs in its own process (`bench-child.mjs`) so
`process.resourceUsage().maxRSS` reports the peak RSS of that run alone. The
timing brackets `runCli` only, which leaves Node's own ~40 ms startup out of every
number — no number here includes it.

One repository's crash cannot end the sweep, on either side of that boundary: the
child process contains a crash inside a measured invocation, and the sweep catches
everything around it — a clone that will not check out, an IR that will not parse
— as a fault against that repository alone.

A run counts as a measurement only if it produced a measurement line, exited 0 or
3, and wrote an IR of its own. Exit 3 is a *completed* run whose workspace was not
clean (`cli-spec.md` §9) and its numbers are real, so the report prints the exit
code rather than a verdict. Anything else has no number to record, and reporting
it as one is the failure mode the removal of the IR before each run exists to
prevent.

`--no-timestamp` removes the only intentionally varying field in the IR, so the
hashes of two runs over an unchanged tree must match. That is the single-threaded
form of performance.md Rule PF-11 (§7.1); once the worker pool lands, the same
equality across `--concurrency` values is the check that matters. A single
measured run compares nothing, and the report says `n/a` rather than a tick.

`report.mjs` holds every decision this makes without touching the disk — what a
run is allowed to claim, and how a sweep renders — and `test/` checks it, including
that the committed samples still render to the committed report.

## The pinned commits

`repos.json` pins `head` for every repo and `base` at `head~50`, which gives
`aburi diff` a real change set to project rather than a handful of commits.
Numbers are only comparable within one pin — changing an entry is a documented
event, and the results file records the commit each run measured.

## Running it on a schedule

The `Benchmark` workflow runs the whole sweep on the first of each month, and on
demand from the Actions tab (`--only` and `--runs` are inputs). It builds the CLI
from the commit it runs on, keeps its work directory in the runner's temporary
space, uploads `results/` as an artifact, and opens a pull request holding the new
`results/<date>.{json,md}` with the rendered tables as its body.

The pull request is where the reading happens. A wall time that moved may mean the
code moved or may mean the runner did — the counters are what carry across runners,
and the workflow deliberately does not decide which one it was. Fixing the runner to
`ubuntu-latest` and the commits to `repos.json` is what keeps the comparison honest;
neither changes without a reason written down.
