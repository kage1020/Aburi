#!/usr/bin/env node
/**
 * Runs `aburi scan` and `aburi diff` against pinned commits of real public repositories
 * and writes the numbers to `results/`.
 *
 * The synthetic corpus described in docs/design/performance.md §2 measures one shape on
 * purpose: many similar small files. Public repositories measure the shapes nobody
 * designs for — a generated file thousands of lines long, a workspace with a hundred
 * packages, a `.d.ts` wall, decorators on everything — and they are also the only way to
 * find out whether Aburi extracts anything sensible from code it has never seen. So each
 * repo yields two kinds of number: cost (wall time, peak RSS) and outcome (files parsed,
 * symbols kept, calls resolved, files lost).
 *
 *   node benchmarks/public-repos/run.mjs                    # every repo in repos.json
 *   node benchmarks/public-repos/run.mjs --only zod,nest    # a subset
 *   node benchmarks/public-repos/run.mjs --runs 5           # more samples per repo
 *   node benchmarks/public-repos/run.mjs --no-diff          # scan only
 *
 * Requires `pnpm build` first: the harness runs the built CLI from `packages/cli/dist`.
 *
 * What each measurement is allowed to claim lives in `report.mjs`, which holds every
 * decision this file makes without touching the disk.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { cpus, totalmem } from "node:os"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  containsPath,
  parseArgs,
  renderReport,
  resolveRepos,
  scrubPaths,
  summariseScans,
} from "./report.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "../..")
const CLI_ENTRY = resolve(REPO_ROOT, "packages/cli/dist/index.mjs")
const CHILD = resolve(HERE, "bench-child.mjs")

/** Enough of a failing run's output to read, taken from the head, where the first error is. */
const CAPTURED_OUTPUT_BYTES = 4000

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
 *
 * `out` and `aburi.json` survive the clean because they are the harness's own: the rewritten
 * config has to outlive the checkout, and the IR directory is emptied per run instead.
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

/**
 * The outcome half of the measurement. Wall time alone cannot tell a fast scan from a
 * scan that gave up on half the workspace, so every timing below is reported next to what
 * the run actually produced.
 *
 * Every field reads as `null` when the IR does not carry it, including the ones the schema
 * marks required. A `?? 0` there would render a renamed field as `Files 0 / Kept 0` — schema
 * drift printed as a catastrophic regression, with nothing to say which it was.
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
    components: ir.components?.length ?? null,
    totalFiles: stats.totalFiles ?? null,
    parsedFiles: stats.parsedFiles ?? null,
    keptSymbols: stats.keptSymbols ?? null,
    droppedSymbols: stats.droppedSymbols ?? null,
    symbols: ir.symbols?.length ?? null,
    dependencies: ir.dependencies?.length ?? null,
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
  const capture = (text) => scrubPaths(text, options.workDir).slice(0, CAPTURED_OUTPUT_BYTES)
  process.stderr.write(`\n=== ${repo.id} ===\n`)
  const dir = await ensureClone(repo, options.workDir)

  const init = await bench(dir, ["init", "--force"], 300_000)
  process.stderr.write(`  init ${init.wallMs?.toFixed(0)} ms (exit ${init.exitCode})\n`)
  if (init.exitCode !== 0) {
    return {
      id: repo.id,
      head: repo.head,
      failed: "init",
      fault: `exit ${init.exitCode}`,
      init,
      elapsedMs: Date.now() - started,
    }
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

  const runs = []
  const irPath = resolve(dir, "out/aburi.ir.json")
  let lastStderr = ""
  for (let i = 0; i < options.warmup + options.runs; i++) {
    /**
     * The previous run's IR goes before this one starts. Left in place, a run that dies is
     * indistinguishable from one that succeeded: the file is there, it hashes to the same
     * bytes, and the sweep records a fast deterministic scan having measured nothing.
     */
    await rm(irPath, { force: true })
    const measurement = await bench(dir, ["scan", "--no-timestamp"], 1_800_000)
    const warm = i < options.warmup
    process.stderr.write(
      `  scan${warm ? " (warmup)" : ""} ${measurement.wallMs?.toFixed(0)} ms · ` +
        `${(measurement.maxRssKb / 1024).toFixed(0)} MiB (exit ${measurement.exitCode})\n`,
    )
    lastStderr = measurement.stderr
    if (warm) continue
    const irWritten = existsSync(irPath)
    runs.push({ measurement, irWritten, hash: irWritten ? await hashFile(irPath) : null })
  }

  const scan = summariseScans(runs, { warnings: capture(lastStderr) })
  if (scan.failed) {
    return {
      id: repo.id,
      head: repo.head,
      failed: scan.failed,
      fault: scan.fault,
      detected,
      scan: { warnings: scan.warnings },
      elapsedMs: Date.now() - started,
    }
  }

  const ir = JSON.parse(await readFile(irPath, "utf8"))
  const metrics = readIrMetrics(ir, (await stat(irPath)).size)
  // Assigned rather than passed, so the file count the IR reports lands in the slot
  // `summariseScans` already reserved for it.
  scan.filesPerSecond =
    metrics.totalFiles == null ? null : metrics.totalFiles / (scan.wallMsMedian / 1000)

  const result = {
    id: repo.id,
    url: repo.url,
    head: repo.head,
    base: repo.base,
    note: repo.note,
    detected,
    init: { wallMs: init.wallMs, maxRssKb: init.maxRssKb, exitCode: init.exitCode },
    scan,
    metrics,
  }

  if (options.diff) {
    /**
     * `--config` with an absolute path, because `aburi diff` scans the base ref inside a
     * throwaway `git worktree`. The harness's `aburi.json` is untracked, so it does not exist
     * in that worktree, and without it the base scan finds no language plugin and aborts with
     * `No language plugin is configured` (exit 2).
     *
     * The CLI warns on every repo that the config sits outside the workspace root it detected
     * for the worktree. The rewritten config carries nothing but absolute plugin refs, so
     * nothing in it resolves against that root — but the warning is real and every diff run
     * here carries it.
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
      warnings: capture(measurement.stderr),
    }
  }

  result.elapsedMs = Date.now() - started
  return result
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
  if (containsPath(REPO_ROOT, options.workDir)) {
    throw new Error(
      `--work-dir must sit outside ${REPO_ROOT}; a clone below it is absorbed into this ` +
        "workspace and the scan measures the wrong tree.",
    )
  }
  const manifest = JSON.parse(await readFile(resolve(HERE, "repos.json"), "utf8"))
  const repos = resolveRepos(manifest, options.only)

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

  const stamp = report.startedAt.slice(0, 10)
  await mkdir(resolve(HERE, "results"), { recursive: true })
  const jsonPath = resolve(HERE, "results", `${stamp}.json`)
  const mdPath = resolve(HERE, "results", `${stamp}.md`)
  const write = async () => {
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(mdPath, renderReport(report))
  }

  for (const repo of repos) {
    try {
      report.results.push(await measureRepo(repo, options))
    } catch (error) {
      /**
       * A clone that will not check out, or an IR the harness cannot parse, costs that
       * repository and no other. `bench-child` already contains a crash inside one measured
       * invocation; this contains everything around it, which is the other half of the same
       * promise — and the report is rewritten per repo so a sweep killed by the job timeout
       * still leaves every repository it finished.
       */
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`  harness fault: ${message}\n`)
      report.results.push({
        id: repo.id,
        head: repo.head,
        failed: "harness",
        fault: scrubPaths(message, options.workDir).slice(0, CAPTURED_OUTPUT_BYTES),
      })
    }
    await write()
  }

  process.stderr.write(`\n→ ${relative(REPO_ROOT, jsonPath)}\n→ ${relative(REPO_ROOT, mdPath)}\n`)
}

await main()
