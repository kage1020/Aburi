import { tmpdir } from "node:os"
import { posix, resolve, win32 } from "node:path"

const COMPLETED_EXIT_CODES = new Set([0, 3])

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

export function summariseScans(runs, options = {}) {
  for (const [index, entry] of runs.entries()) {
    const fault = scanRunFault(entry.measurement, entry.irWritten)
    if (fault) return { failed: "scan", fault: `run ${index + 1} of ${runs.length}: ${fault}` }
  }
  const wallMsSamples = runs.map((entry) => entry.measurement.wallMs)
  const hashes = runs.map((entry) => entry.hash)
  const wallMsMedian = median(wallMsSamples)
  const { totalFiles = null, warnings = "" } = options
  const exitCodes = runs.map((entry) => entry.measurement.exitCode)
  return {
    runs: runs.length,
    exitCode: exitCodes[exitCodes.length - 1],
    exitCodes,
    wallMsSamples,
    wallMsMedian,
    wallMsMin: Math.min(...wallMsSamples),
    wallMsMax: Math.max(...wallMsSamples),
    peakRssKb: Math.max(...runs.map((entry) => entry.measurement.maxRssKb)),
    filesPerSecond: totalFiles == null ? null : totalFiles / (wallMsMedian / 1000),
    irHash: hashes[0],
    irHashes: hashes,
    deterministic: hashes.length < 2 ? null : hashes.every((hash) => hash === hashes[0]),
    warnings,
  }
}

export function scrubPaths(text, workDir) {
  const variants = new Set([workDir, workDir.replaceAll("\\", "/"), workDir.replaceAll("/", "\\")])
  let scrubbed = text
  for (const variant of variants) scrubbed = scrubbed.split(variant).join("<work-dir>")
  return scrubbed.replace(/\S*aburi-worktree-[A-Za-z0-9]+/g, "<base-worktree>")
}

export function countRecoverableParseErrors(warnings) {
  const counts = [...warnings.matchAll(/(\d+) file\(s\) had recoverable parse errors/g)].map(
    (match) => Number(match[1]),
  )
  return counts.length === 0 ? 0 : Math.max(...counts)
}

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

function formatExitCodes(scan) {
  const codes = scan.exitCodes ?? [scan.exitCode]
  if (codes.every((code) => code === codes[0])) return formatCount(codes[0])
  return codes.join("/")
}

export function renderReport(report) {
  const lines = []
  const { environment, results } = report
  lines.push("# Public-repository benchmark")
  lines.push("")
  lines.push(
    `Run ${report.startedAt} · aburi ${report.generator ?? "workspace build"}` +
      `${report.commit ? ` at \`${report.commit.slice(0, 8)}\`${report.dirty ? " + uncommitted changes" : ""}` : ""} · ` +
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
        formatExitCodes(scan),
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
