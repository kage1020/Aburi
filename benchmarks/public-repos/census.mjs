#!/usr/bin/env node
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import {
  callSiteKey,
  drawIndices,
  isTestPath,
  parseCensusArgs,
  renderCheck,
  renderShares,
} from "./census-report.mjs"
import { containsPath, resolveRepos } from "./report.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "../..")
const CLI_ENTRY = resolve(REPO_ROOT, "packages/cli/dist/index.mjs")
const CENSUS_PATH = resolve(HERE, "no-match/sample.json")
const CODE_CHARS = 160

const run = promisify(execFile)

async function git(args, cwd) {
  return (await run("git", args, { cwd })).stdout.trim()
}

async function scanClone(repo, workDir) {
  const dir = resolve(workDir, repo.id)
  if (!existsSync(resolve(dir, "aburi.json"))) {
    throw new Error(
      `${dir} has no aburi.json. Run \`node benchmarks/public-repos/run.mjs --only ${repo.id} ` +
        "--runs 1 --warmup 0 --no-diff` first: it clones the repository and writes the config.",
    )
  }
  const head = await git(["rev-parse", "HEAD"], dir)
  if (head !== repo.head) {
    throw new Error(`${dir} is at ${head}, not the pinned ${repo.head}; the census reads the pin.`)
  }
  const { runScan } = await import(pathToFileURL(CLI_ENTRY).href)
  const outputDir = await mkdtemp(resolve(tmpdir(), "aburi-census-"))
  try {
    const report = await runScan({
      cwd: dir,
      outputDir,
      format: "json",
      suppressTimestamp: true,
      logLevel: "error",
    })
    const ir = JSON.parse(await readFile(report.irPath, "utf8"))
    return { dir, ir, unresolved: report.unresolvedCalls }
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
}

function baselineOf(repo, ir) {
  const stats = ir.stats.callResolution
  return {
    id: repo.id,
    head: repo.head,
    calls: stats.totalCalls,
    resolved: stats.resolvedCalls,
    unresolved: stats.unresolved,
  }
}

async function draw(options, repos) {
  const census = {
    seed: options.seed,
    perRepo: options.perRepo,
    aburi: {
      version: JSON.parse(await readFile(resolve(REPO_ROOT, "packages/cli/package.json"), "utf8"))
        .version,
      commit: await git(["rev-parse", "HEAD"], REPO_ROOT),
    },
    repos: [],
    categories: {},
    samples: [],
  }
  for (const repo of repos) {
    process.stderr.write(`scanning ${repo.id}\n`)
    const { dir, ir, unresolved } = await scanClone(repo, options.workDir)
    census.repos.push(baselineOf(repo, ir))
    const fileOf = new Map(ir.symbols.map((symbol) => [symbol.id, symbol.source.file]))
    const frame = unresolved.filter((call) => call.bucket === "no-match")
    const lines = new Map()
    for (const index of drawIndices(frame.length, options.perRepo, `${options.seed}:${repo.id}`)) {
      const call = frame[index]
      const file = fileOf.get(call.symbolId)
      if (!lines.has(file))
        lines.set(file, (await readFile(resolve(dir, file), "utf8")).split("\n"))
      census.samples.push({
        repo: repo.id,
        file,
        line: call.line,
        symbol: call.symbolId,
        target: call.target,
        test: isTestPath(file),
        code: (lines.get(file)[call.line - 1] ?? "").trim().slice(0, CODE_CHARS),
        category: null,
        expected: null,
        note: null,
      })
    }
  }
  process.stdout.write(`${JSON.stringify(census, null, 2)}\n`)
}

function callSitesOf(ir, unresolved) {
  const sites = new Map()
  for (const symbol of ir.symbols) {
    for (const call of symbol.calls ?? []) {
      const key = callSiteKey({ symbol: symbol.id, line: call.line, target: call.target })
      if (!sites.has(key)) sites.set(key, { resolved: call.resolved, bucket: null })
    }
  }
  for (const call of unresolved) {
    const site = sites.get(
      callSiteKey({ symbol: call.symbolId, line: call.line, target: call.target }),
    )
    if (site !== undefined && site.bucket === null) site.bucket = call.bucket
  }
  return sites
}

async function check(options, manifest) {
  const census = JSON.parse(await readFile(CENSUS_PATH, "utf8"))
  const repos = resolveRepos(
    manifest,
    census.repos.map((repo) => repo.id),
  )
  const current = new Map()
  const baselines = []
  for (const repo of repos) {
    const recorded = census.repos.find((entry) => entry.id === repo.id)
    if (recorded.head !== repo.head) {
      throw new Error(
        `repos.json pins ${repo.id} at ${repo.head}, but the census sampled ${recorded.head}; ` +
          "its call sites are not comparable across pins.",
      )
    }
    process.stderr.write(`scanning ${repo.id}\n`)
    const { ir, unresolved } = await scanClone(repo, options.workDir)
    current.set(repo.id, callSitesOf(ir, unresolved))
    baselines.push({ recorded, now: baselineOf(repo, ir) })
  }
  const lines = ["| Repo | Resolved then | Resolved now |", "|---|---:|---:|"]
  for (const { recorded, now } of baselines) {
    const share = (entry) =>
      `${entry.resolved} / ${entry.calls} (${((100 * entry.resolved) / entry.calls).toFixed(1)}%)`
    lines.push(`| \`${recorded.id}\` | ${share(recorded)} | ${share(now)} |`)
  }
  process.stdout.write(`${lines.join("\n")}\n\n${renderCheck(census, current)}`)
}

async function main() {
  const options = parseCensusArgs(process.argv.slice(2))
  if (options.mode === "shares") {
    process.stdout.write(renderShares(JSON.parse(await readFile(CENSUS_PATH, "utf8"))))
    return
  }
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`${relative(REPO_ROOT, CLI_ENTRY)} is missing. Run \`pnpm build\` first.`)
  }
  if (containsPath(REPO_ROOT, options.workDir)) {
    throw new Error(`--work-dir must sit outside ${REPO_ROOT}, where run.mjs keeps its clones.`)
  }
  const manifest = JSON.parse(await readFile(resolve(HERE, "repos.json"), "utf8"))
  if (options.mode === "draw") await draw(options, resolveRepos(manifest, options.only))
  else await check(options, manifest)
}

await main()
