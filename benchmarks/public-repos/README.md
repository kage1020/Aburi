# Public-repository benchmark

Runs `aburi scan` and `aburi diff` against pinned commits of nine public
repositories and records both what it cost and what it produced.

The synthetic corpus in [`docs/design/performance.md`](../../docs/design/performance.md)
§2 measures one shape deliberately: 1,200 similar small files, which is the shape
the planned worker pool exists for. Public repositories measure the shapes nobody
designs for — an 8,000-line generated file, a workspace with 80 packages, a wall
of `.d.ts`, decorators on every class — and they are the only way to find out
whether Aburi extracts anything sensible from code it has never seen. So the two
benchmarks answer different questions and neither replaces the other.

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

Results land in `results/<date>.json` (every sample and every counter) and
`results/<date>.md` (the tables worth reading).

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

1. Check the clone out at the pinned `head`, and `git clean -xfd` it.
2. Run `aburi init` (measured) and keep what it detected.
3. Rewrite the detected plugin refs to `file://` URLs for this checkout's built
   plugins. A benchmark clone has no `node_modules`, and installing the workspace
   into nine unrelated repositories would cost more than the measurement and risk
   measuring a published version instead of the working tree.
4. Run `aburi scan --no-timestamp` `--warmup` + `--runs` times, hashing the IR
   after each measured run.
5. Read the IR for the outcome counters.
6. Run `aburi diff <base>..<head>` once, with `--config` pointing at the
   rewritten config — the base ref is scanned inside a throwaway `git worktree`
   where the harness's untracked `aburi.json` does not exist.

Each measurement runs in its own process (`bench-child.mjs`) so
`process.resourceUsage().maxRSS` reports the peak RSS of that run alone, and so
one repo's crash cannot end the sweep. The timing brackets `runCli` only, which
leaves Node's own ~40 ms startup out of every number.

`--no-timestamp` removes the only intentionally varying field in the IR, so the
hashes of two runs over an unchanged tree must match. That is the single-threaded
form of performance.md PF11; once the worker pool lands, the same equality across
`--concurrency` values is the check that matters.

## The pinned commits

`repos.json` pins `head` for every repo and `base` at `head~50`, which gives
`aburi diff` a real change set to project rather than a handful of commits.
Numbers are only comparable within one pin — changing an entry is a documented
event, and the results file records the commit each run measured.
