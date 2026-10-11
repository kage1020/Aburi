#!/usr/bin/env node
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
      exitCode: measurement.exitCode,
      summary: counts,
      warnings: capture(measurement.stderr),
    }
  }

  result.elapsedMs = Date.now() - started
  return result
}

async function aburiCommit() {
  const commit = await git(["rev-parse", "HEAD"], REPO_ROOT)
  const status = await git(
    ["status", "--porcelain", "--", ".", ":(exclude)benchmarks/public-repos/results"],
    REPO_ROOT,
  )
  return { commit, dirty: status !== "" }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`${relative(REPO_ROOT, CLI_ENTRY)} is missing. Run \`pnpm build\` first.`)
  }
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
    ...(await aburiCommit()),
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
