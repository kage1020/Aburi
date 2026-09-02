/**
 * Everything the harness decides without touching the disk: which arguments and which
 * repositories are acceptable, whether a measured run counts as a measurement, and how a
 * finished sweep renders.
 *
 * Split out of `run.mjs` so those decisions can be tested against the committed samples.
 * `run.mjs` keeps the clones, the child processes and the writes.
 */
import { tmpdir } from "node:os"
import { posix, resolve, win32 } from "node:path"

/**
 * The exit codes a *completed* scan can return. 0 is clean and 3 is a tripped gate — the run
 * finished, wrote its IR, and reported that something in the workspace was not clean
 * (`cli-spec.md` §9). `zod` exits 3 on every run here because one file's extraction throws,
 * and its numbers are real; flattening that to "failed" would discard the measurement.
 * 1 (runtime) and 2 (input) mean the opposite: there is no answer to record.
 */
const COMPLETED_EXIT_CODES = new Set([0, 3])

/**
 * Why this run cannot be counted as a measurement, or `null` if it can.
 *
 * `irWritten` has to be observed *after* the harness removed the previous run's IR. Without
 * that removal a run that dies leaves its predecessor's file in place, and the hash taken
 * from it makes the sweep look deterministic having compared nothing.
 */
export function scanRunFault(measurement, irWritten) {
  if (measurement.wallMs == null) return measurement.failure ?? "no measurement line"
  if (!COMPLETED_EXIT_CODES.has(measurement.exitCode)) return `exit ${measurement.exitCode}`
  if (!irWritten) return "no IR was written"
  return null
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * The measured runs reduced to the row the report prints — or the reason there is no row.
 * One faulted run condemns the repository rather than being averaged out of sight: a sweep
 * that quietly measured two runs where three were asked for is not the sweep in the header.
 */
export function summariseScans(runs, options = {}) {
  for (const [index, entry] of runs.entries()) {
    const fault = scanRunFault(entry.measurement, entry.irWritten)
    if (fault) return { failed: "scan", fault: `run ${index + 1} of ${runs.length}: ${fault}` }
  }
  const wallMsSamples = runs.map((entry) => entry.measurement.wallMs)
  const hashes = runs.map((entry) => entry.hash)
  const wallMsMedian = median(wallMsSamples)
  const { totalFiles = null, warnings = "" } = options
  return {
    runs: runs.length,
    exitCode: runs[runs.length - 1].measurement.exitCode,
    wallMsSamples,
    wallMsMedian,
    wallMsMin: Math.min(...wallMsSamples),
    wallMsMax: Math.max(...wallMsSamples),
    peakRssKb: Math.max(...runs.map((entry) => entry.measurement.maxRssKb)),
    filesPerSecond: totalFiles == null ? null : totalFiles / (wallMsMedian / 1000),
    irHash: hashes[0],
    /**
     * `--no-timestamp` removes the only intentionally varying field, so two runs over an
     * unchanged tree must serialise to the same bytes — the single-threaded half of
     * performance.md Rule PF-11 (§7.1). One run compares nothing, and `[x].every(...)` is
     * true for the same reason `[].every(...)` is, so it reports unmeasured rather than a tick.
     */
    deterministic: hashes.length < 2 ? null : hashes.every((hash) => hash === hashes[0]),
    warnings,
  }
}

/**
 * The absolute paths a run's output carries: the harness work directory, and the throwaway
 * worktree `aburi diff` checks the base ref out into, whose suffix is random per run. Both
 * belong to the machine that measured rather than to the measurement, so a results file that
 * keeps them diffs on them every month and pins one machine's scratch path in the repository
 * for good.
 */
export function scrubPaths(text, workDir) {
  const variants = new Set([workDir, workDir.replaceAll("\\", "/"), workDir.replaceAll("/", "\\")])
  let scrubbed = text
  for (const variant of variants) scrubbed = scrubbed.split(variant).join("<work-dir>")
  return scrubbed.replace(/\S*aburi-worktree-[A-Za-z0-9]+/g, "<base-worktree>")
}

/**
 * How many files the scan recovered a parse error in. These reach the IR rather than
 * `stats.skippedFiles`, so `Files lost` counts none of them and no timing column can see them
 * either — the count exists only in the warning the CLI prints. A diff prints one for the base
 * and one for the head, hence the maximum rather than the first.
 */
export function countRecoverableParseErrors(warnings) {
  const counts = [...warnings.matchAll(/(\d+) file\(s\) had recoverable parse errors/g)].map(
    (match) => Number(match[1]),
  )
  return counts.length === 0 ? 0 : Math.max(...counts)
}

/**
 * Whether `candidate` is `root` or sits inside it.
 *
 * A prefix comparison on the string is wrong twice: it calls the sibling `Aburi-bench` a child,
 * and on Windows it misses a path that differs only in case, which is the same directory.
 * `relative()` answers both, and it is the platform's own answer about its own paths.
 */
export function containsPath(root, candidate, platform = process.platform) {
  const api = platform === "win32" ? win32 : posix
  const rel = api.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel))
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (value === undefined) throw new Error(`${flag} needs a value.`)
  return value
}

function requireCount(argv, index, flag, minimum) {
  const raw = requireValue(argv, index, flag)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${flag} needs a whole number of at least ${minimum}, not "${raw}".`)
  }
  return value
}

/**
 * Every flag is validated here rather than where it is read, because the alternative costs the
 * whole sweep: `--runs abc` reaches the scan loop as `NaN`, runs zero iterations, and throws on
 * an empty array after the build and nine clones have already been paid for.
 */
export function parseArgs(argv) {
  const options = {
    only: null,
    runs: 3,
    warmup: 1,
    diff: true,
    workDir: resolve(tmpdir(), "aburi-bench-work"),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--only") options.only = requireValue(argv, ++i, "--only").split(",")
    else if (arg === "--runs") options.runs = requireCount(argv, ++i, "--runs", 1)
    else if (arg === "--warmup") options.warmup = requireCount(argv, ++i, "--warmup", 0)
    else if (arg === "--no-diff") options.diff = false
    else if (arg === "--work-dir") options.workDir = resolve(requireValue(argv, ++i, "--work-dir"))
    else throw new Error(`Unknown flag: ${arg}`)
  }
  return options
}

/**
 * An id the manifest does not carry is a typo, not a filter. Reporting a one-row sweep for
 * `--only "zod, nest"` — where the space makes the second id unknown — would record measuring
 * one repository as if that had been the intent.
 */
export function resolveRepos(manifest, only) {
  if (only === null) return manifest.repos
  const known = manifest.repos.map((repo) => repo.id)
  const unknown = only.filter((id) => !known.includes(id))
  if (unknown.length > 0) {
    throw new Error(
      `--only names ${unknown.map((id) => `"${id}"`).join(", ")}, which repos.json does not ` +
        `carry. Known ids: ${known.join(", ")}.`,
    )
  }
  return manifest.repos.filter((repo) => only.includes(repo.id))
}

function formatMiB(kb) {
  return kb == null ? "—" : (kb / 1024).toFixed(0)
}

function formatSeconds(ms) {
  return ms == null ? "—" : (ms / 1000).toFixed(2)
}

function formatCount(value) {
  return value == null ? "—" : String(value)
}

function row(cells) {
  return `| ${cells.join(" | ")} |`
}

function dashes(count) {
  return Array.from({ length: count }, () => "—")
}

export function renderReport(report) {
  const lines = []
  const { environment, results } = report
  lines.push("# Public-repository benchmark")
  lines.push("")
  lines.push(
    `Run ${report.startedAt} · aburi ${report.generator ?? "workspace build"} · ` +
      `Node ${environment.node} · ${environment.cpus}× ${environment.cpuModel} · ` +
      `${environment.totalMemGiB} GiB RAM · ${report.options.runs} measured run(s) after ` +
      `${report.options.warmup} warmup.`,
  )
  lines.push("")
  lines.push("## Scan")
  lines.push("")
  lines.push(
    row([
      "Repo",
      "Files",
      "Kept",
      "Dropped",
      "Median",
      "Min–max",
      "files/s",
      "Peak RSS",
      "IR",
      "Exit",
      "Deterministic",
    ]),
  )
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|")
  for (const result of results) {
    if (result.failed) {
      const fault = result.fault ? ` (${result.fault})` : ""
      lines.push(row([`\`${result.id}\``, ...dashes(8), `✗ ${result.failed}${fault}`, "—"]))
      continue
    }
    const { scan, metrics } = result
    lines.push(
      row([
        `\`${result.id}\``,
        formatCount(metrics.totalFiles),
        formatCount(metrics.keptSymbols),
        formatCount(metrics.droppedSymbols),
        `${formatSeconds(scan.wallMsMedian)} s`,
        `${formatSeconds(scan.wallMsMin)}–${formatSeconds(scan.wallMsMax)} s`,
        scan.filesPerSecond == null ? "—" : scan.filesPerSecond.toFixed(0),
        `${formatMiB(scan.peakRssKb)} MiB`,
        metrics.irBytes == null ? "—" : `${(metrics.irBytes / 1024 / 1024).toFixed(1)} MiB`,
        formatCount(scan.exitCode),
        scan.deterministic == null ? "n/a" : scan.deterministic ? "✓" : "✗",
      ]),
    )
  }
  lines.push("")
  lines.push("## Call resolution and losses")
  lines.push("")
  lines.push(
    row([
      "Repo",
      "Components",
      "Calls",
      "Resolved",
      "Resolved %",
      "Deps",
      "Parse errors",
      "Files lost",
      "Reasons",
    ]),
  )
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---|")
  for (const result of results) {
    if (result.failed) {
      lines.push(row([`\`${result.id}\``, ...dashes(7), `✗ ${result.failed}`]))
      continue
    }
    const metrics = result.metrics
    const share =
      metrics.totalCalls > 0 && metrics.resolvedCalls != null
        ? `${((metrics.resolvedCalls / metrics.totalCalls) * 100).toFixed(1)}%`
        : "—"
    const reasons =
      Object.entries(metrics.skippedByReason)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(", ") || "—"
    lines.push(
      row([
        `\`${result.id}\``,
        formatCount(metrics.components),
        formatCount(metrics.totalCalls),
        formatCount(metrics.resolvedCalls),
        share,
        formatCount(metrics.dependencies),
        String(countRecoverableParseErrors(result.scan.warnings ?? "")),
        formatCount(metrics.skippedFiles),
        reasons,
      ]),
    )
  }
  if (results.some((result) => result.diff)) {
    lines.push("")
    lines.push("## Diff (`base..head`, 50 commits apart)")
    lines.push("")
    lines.push(row(["Repo", "Wall", "Peak RSS", "Exit", "Added", "Removed", "Changed", "Moved"]))
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|")
    for (const result of results) {
      if (!result.diff) continue
      const summary = result.diff.summary ?? {}
      lines.push(
        row([
          `\`${result.id}\``,
          `${formatSeconds(result.diff.wallMs)} s`,
          `${formatMiB(result.diff.peakRssKb)} MiB`,
          formatCount(result.diff.exitCode),
          formatCount(summary.added),
          formatCount(summary.removed),
          formatCount(summary.changed),
          formatCount(summary.moved),
        ]),
      )
    }
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}
