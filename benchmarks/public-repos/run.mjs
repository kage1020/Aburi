#!/usr/bin/env node
/**
 * Runs `aburi scan` and `aburi diff` against pinned commits of real public repositories
 * and writes the numbers to `results/`.
 *
 * The synthetic corpus described in docs/design/performance.md §2 measures one shape on
 * purpose: many similar small files. Public repositories measure the shapes nobody
 * designs for — a 5,000-line generated file, a workspace with 80 packages, a `.d.ts`
 * wall, decorators on everything — and they are also the only way to find out whether
 * Aburi extracts anything sensible from code it has never seen. So each repo yields two
 * kinds of number: cost (wall time, peak RSS) and outcome (files parsed, symbols kept,
 * calls resolved, files lost).
 *
 *   node benchmarks/public-repos/run.mjs                    # every repo in repos.json
 *   node benchmarks/public-repos/run.mjs --only zod,nest    # a subset
 *   node benchmarks/public-repos/run.mjs --runs 5           # more samples per repo
 *   node benchmarks/public-repos/run.mjs --no-diff          # scan only
 *
 * Requires `pnpm build` first: the harness runs the built CLI from `packages/cli/dist`.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { cpus, tmpdir, totalmem } from "node:os"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "../..")
const CLI_ENTRY = resolve(REPO_ROOT, "packages/cli/dist/index.mjs")
const CHILD = resolve(HERE, "bench-child.mjs")

/**
 * `aburi init` writes plugin refs as bare package names (`lang-typescript`), which the
 * loader resolves through `node_modules` — the shape a real user installs. A benchmark
 * clone has no `node_modules`, and installing the workspace's dependencies into nine
 * unrelated repositories would both cost more than the measurement and risk measuring a
 * published version instead of the working tree. The loader also accepts a relative path
 * ref, and hands anything containing a `/` to `import()` untouched (plugin-loader.ts
 * `resolveSpecifier`), so the harness rewrites each detected ref to a `file://` URL for the
 * built plugin in this checkout. Same plugin objects, no install.
 *
 * A `file://` URL rather than the relative form the loader also accepts: a relative ref
 * resolves against the *workspace root* Aburi detects for the clone, which is not a path this
 * harness knows before the scan runs.
 */
function pluginRef(ref) {
  const name = ref.replace(/^@aburi\//, "")
  return pathToFileURL(resolve(REPO_ROOT, "packages", name, "dist/index.mjs")).href
}

function parseArgs(argv) {
  const options = {
    only: null,
    runs: 3,
    warmup: 1,
    diff: true,
    workDir: resolve(tmpdir(), "aburi-bench-work"),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--only") options.only = new Set(argv[++i].split(","))
    else if (arg === "--runs") options.runs = Number(argv[++i])
    else if (arg === "--warmup") options.warmup = Number(argv[++i])
    else if (arg === "--no-diff") options.diff = false
    else if (arg === "--work-dir") options.workDir = resolve(argv[++i])
    else throw new Error(`Unknown flag: ${arg}`)
  }
  return options
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    })
    let stdout = ""
    let stderr = ""
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL")
          stderr += `\n[harness] killed after ${options.timeoutMs} ms\n`
        }, options.timeoutMs)
      : null
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr })
    })
  })
}

async function git(args, cwd) {
  const result = await run("git", args, { cwd })
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`)
  return result.stdout.trim()
}

/**
 * A `--filter=blob:none` clone, not `--depth 1`: `aburi diff` refuses a shallow repository
 * (it needs the base ref's history), while a partial clone keeps every commit and fetches
 * only the blobs a checkout actually touches. Over these nine repos that is ~125 MB of
 * fetch, and ~760 MB of work directory once every tree is materialised.
 */
async function ensureClone(repo, workDir) {
  const dir = resolve(workDir, repo.id)
  if (!existsSync(resolve(dir, ".git"))) {
    await mkdir(workDir, { recursive: true })
    await git(["clone", "--filter=blob:none", "--no-checkout", repo.url, dir])
  }
  await git(["checkout", "--force", "--detach", repo.head], dir)
  await git(["clean", "-xfd", "--exclude=out", "--exclude=aburi.json"], dir)
  return dir
}

function bench(dir, args, timeoutMs) {
  return run(process.execPath, [CHILD, CLI_ENTRY, ...args], { cwd: dir, timeoutMs }).then(
    (result) => {
      const marker = result.stdout.lastIndexOf("##BENCH##")
      const measurement =
        marker === -1
          ? { wallMs: null, maxRssKb: null, exitCode: result.code, failure: "no measurement line" }
          : JSON.parse(result.stdout.slice(marker + "##BENCH##".length).trim())
      return { ...measurement, stdout: result.stdout, stderr: result.stderr, signal: result.signal }
    },
  )
}

async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * The outcome half of the measurement. Wall time alone cannot tell a fast scan from a
 * scan that gave up on half the workspace, so every timing below is reported next to what
 * the run actually produced.
 */
function readIrMetrics(ir, irBytes) {
  const stats = ir.stats ?? {}
  const calls = stats.callResolution ?? null
  const skipped = stats.skippedFiles ?? []
  const skippedByReason = {}
  for (const entry of skipped) {
    skippedByReason[entry.reason] = (skippedByReason[entry.reason] ?? 0) + 1
  }
  return {
    components: ir.components?.length ?? 0,
    totalFiles: stats.totalFiles ?? 0,
    parsedFiles: stats.parsedFiles ?? 0,
    keptSymbols: stats.keptSymbols ?? 0,
    droppedSymbols: stats.droppedSymbols ?? 0,
    symbols: ir.symbols?.length ?? 0,
    dependencies: ir.dependencies?.length ?? 0,
    totalCalls: calls?.totalCalls ?? null,
    resolvedCalls: calls?.resolvedCalls ?? null,
    unresolved: calls?.unresolved ?? null,
    skippedFiles: skipped.length,
    skippedByReason,
    skippedSample: skipped.slice(0, 5),
    irBytes,
  }
}

async function measureRepo(repo, options) {
  const started = Date.now()
  process.stderr.write(`\n=== ${repo.id} ===\n`)
  const dir = await ensureClone(repo, options.workDir)
  await rm(resolve(dir, "out"), { recursive: true, force: true })

  const init = await bench(dir, ["init", "--force"], 300_000)
  process.stderr.write(`  init ${init.wallMs?.toFixed(0)} ms (exit ${init.exitCode})\n`)
  if (init.exitCode !== 0) {
    return { id: repo.id, head: repo.head, failed: "init", init, elapsedMs: Date.now() - started }
  }

  const configPath = resolve(dir, "aburi.json")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  const detected = {
    languages: [...(config.languages ?? [])],
    frameworks: [...(config.frameworks ?? [])],
    effects: [...(config.effects ?? [])],
  }
  for (const bucket of ["languages", "frameworks", "effects"]) {
    if (!config[bucket]) continue
    config[bucket] = config[bucket].map(pluginRef)
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const scans = []
  const hashes = []
  const irPath = resolve(dir, "out/aburi.ir.json")
  for (let i = 0; i < options.warmup + options.runs; i++) {
    const measurement = await bench(dir, ["scan", "--no-timestamp"], 1_800_000)
    const warm = i < options.warmup
    process.stderr.write(
      `  scan${warm ? " (warmup)" : ""} ${measurement.wallMs?.toFixed(0)} ms · ` +
        `${(measurement.maxRssKb / 1024).toFixed(0)} MiB (exit ${measurement.exitCode})\n`,
    )
    if (!existsSync(irPath)) {
      return {
        id: repo.id,
        head: repo.head,
        failed: "scan",
        detected,
        scan: { exitCode: measurement.exitCode, stderr: measurement.stderr.slice(-4000) },
        elapsedMs: Date.now() - started,
      }
    }
    if (warm) continue
    scans.push(measurement)
    hashes.push(await hashFile(irPath))
  }

  const ir = JSON.parse(await readFile(irPath, "utf8"))
  const metrics = readIrMetrics(ir, (await stat(irPath)).size)
  const wallMsSamples = scans.map((s) => s.wallMs)

  /**
   * `--no-timestamp` removes the only intentionally varying field, so two runs over an
   * unchanged tree must serialise to the same bytes. This is the single-threaded form of
   * performance.md PF11; when the worker pool lands, the same check across
   * `--concurrency` values is the interesting one.
   */
  const deterministic = hashes.every((hash) => hash === hashes[0])

  const result = {
    id: repo.id,
    url: repo.url,
    head: repo.head,
    base: repo.base,
    note: repo.note,
    detected,
    init: { wallMs: init.wallMs, maxRssKb: init.maxRssKb, exitCode: init.exitCode },
    scan: {
      runs: scans.length,
      exitCode: scans[scans.length - 1].exitCode,
      wallMsSamples,
      wallMsMedian: median(wallMsSamples),
      wallMsMin: Math.min(...wallMsSamples),
      wallMsMax: Math.max(...wallMsSamples),
      peakRssKb: Math.max(...scans.map((s) => s.maxRssKb)),
      filesPerSecond: metrics.totalFiles / (median(wallMsSamples) / 1000),
      irHash: hashes[0],
      deterministic,
      warnings: scans[scans.length - 1].stderr.slice(-4000),
    },
    metrics,
  }

  if (options.diff) {
    /**
     * `--config` with an absolute path, because `aburi diff` scans the base ref inside a
     * throwaway `git worktree`. The harness's `aburi.json` is untracked, so it does not
     * exist in that worktree, and without it the base scan loads no language plugin and
     * parses nothing.
     */
    await rm(resolve(dir, "out-diff"), { recursive: true, force: true })
    const measurement = await bench(
      dir,
      ["diff", `${repo.base}..${repo.head}`, "--output-dir", "out-diff", "--config", configPath],
      1_800_000,
    )
    process.stderr.write(
      `  diff ${measurement.wallMs?.toFixed(0)} ms · ` +
        `${(measurement.maxRssKb / 1024).toFixed(0)} MiB (exit ${measurement.exitCode})\n`,
    )
    const diffPath = resolve(dir, "out-diff/diff.json")
    let counts = null
    if (existsSync(diffPath)) {
      const document = JSON.parse(await readFile(diffPath, "utf8"))
      counts = document.summary ?? null
    }
    result.diff = {
      wallMs: measurement.wallMs,
      peakRssKb: measurement.maxRssKb,
      // Exit 3 is not only a tripped `--fail-on` gate — no gate is passed here — but any
      // run that did not earn a clean answer, which is how `zod`'s extraction failure
      // surfaces. Kept rather than flattened to pass / fail.
      exitCode: measurement.exitCode,
      summary: counts,
      warnings: measurement.stderr.slice(-4000),
    }
  }

  result.elapsedMs = Date.now() - started
  return result
}

function formatMiB(kb) {
  return kb == null ? "—" : (kb / 1024).toFixed(0)
}

function formatSeconds(ms) {
  return ms == null ? "—" : (ms / 1000).toFixed(2)
}

function renderReport(report) {
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
    "| Repo | Files | Kept | Dropped | Median | Min–max | files/s | Peak RSS | IR | Deterministic |",
  )
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|:--:|")
  for (const result of results) {
    if (result.failed) {
      lines.push(`| \`${result.id}\` | — | — | — | — | — | — | — | — | ✗ (${result.failed}) |`)
      continue
    }
    const scan = result.scan
    lines.push(
      `| \`${result.id}\` | ${result.metrics.totalFiles} | ${result.metrics.keptSymbols} | ` +
        `${result.metrics.droppedSymbols} | ${formatSeconds(scan.wallMsMedian)} s | ` +
        `${formatSeconds(scan.wallMsMin)}–${formatSeconds(scan.wallMsMax)} s | ` +
        `${scan.filesPerSecond.toFixed(0)} | ${formatMiB(scan.peakRssKb)} MiB | ` +
        `${(result.metrics.irBytes / 1024 / 1024).toFixed(1)} MiB | ` +
        `${scan.deterministic ? "✓" : "✗"} |`,
    )
  }
  lines.push("")
  lines.push("## Call resolution and losses")
  lines.push("")
  lines.push("| Repo | Components | Calls | Resolved | Resolved % | Deps | Files lost | Reasons |")
  lines.push("|---|---:|---:|---:|---:|---:|---:|---|")
  for (const result of results) {
    if (result.failed) continue
    const metrics = result.metrics
    const share =
      metrics.totalCalls > 0
        ? `${((metrics.resolvedCalls / metrics.totalCalls) * 100).toFixed(1)}%`
        : "—"
    const reasons =
      Object.entries(metrics.skippedByReason)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(", ") || "—"
    lines.push(
      `| \`${result.id}\` | ${metrics.components} | ${metrics.totalCalls ?? "—"} | ` +
        `${metrics.resolvedCalls ?? "—"} | ${share} | ${metrics.dependencies} | ` +
        `${metrics.skippedFiles} | ${reasons} |`,
    )
  }
  if (results.some((result) => result.diff)) {
    lines.push("")
    lines.push("## Diff (`base..head`, 50 commits apart)")
    lines.push("")
    lines.push("| Repo | Wall | Peak RSS | Exit | Added | Removed | Changed | Moved |")
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|")
    for (const result of results) {
      if (!result.diff) continue
      const summary = result.diff.summary ?? {}
      lines.push(
        `| \`${result.id}\` | ${formatSeconds(result.diff.wallMs)} s | ` +
          `${formatMiB(result.diff.peakRssKb)} MiB | ${result.diff.exitCode} | ` +
          `${summary.added ?? "—"} | ${summary.removed ?? "—"} | ${summary.changed ?? "—"} | ` +
          `${summary.moved ?? "—"} |`,
      )
    }
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`${relative(REPO_ROOT, CLI_ENTRY)} is missing. Run \`pnpm build\` first.`)
  }
  /**
   * A clone below this repository would inherit its workspace: `detectWorkspaceRoot` walks
   * up from the scan's cwd, finds Aburi's own `pnpm-workspace.yaml`, and roots every Symbol
   * id there — measuring a workspace nobody asked about. Refuse rather than report the
   * number that comes out of it.
   */
  if (`${options.workDir}${sep}`.startsWith(`${REPO_ROOT}${sep}`)) {
    throw new Error(
      `--work-dir must sit outside ${REPO_ROOT}; a clone below it is absorbed into this ` +
        "workspace and the scan measures the wrong tree.",
    )
  }
  const manifest = JSON.parse(await readFile(resolve(HERE, "repos.json"), "utf8"))
  const repos = manifest.repos.filter((repo) => !options.only || options.only.has(repo.id))
  if (repos.length === 0) throw new Error("No repository matched --only.")

  const report = {
    startedAt: new Date().toISOString(),
    options: { runs: options.runs, warmup: options.warmup, diff: options.diff },
    generator: JSON.parse(await readFile(resolve(REPO_ROOT, "packages/cli/package.json"), "utf8"))
      .version,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unknown",
      totalMemGiB: Math.round(totalmem() / 1024 ** 3),
    },
    results: [],
  }
  for (const repo of repos) {
    report.results.push(await measureRepo(repo, options))
  }

  const stamp = report.startedAt.slice(0, 10)
  await mkdir(resolve(HERE, "results"), { recursive: true })
  const jsonPath = resolve(HERE, "results", `${stamp}.json`)
  const mdPath = resolve(HERE, "results", `${stamp}.md`)
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(mdPath, renderReport(report))
  process.stderr.write(`\n→ ${relative(REPO_ROOT, jsonPath)}\n→ ${relative(REPO_ROOT, mdPath)}\n`)
}

await main()
