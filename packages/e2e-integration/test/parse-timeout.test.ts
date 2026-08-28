import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ScanResult, scan } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { Config, IRSymbol, LanguagePlugin, Logger } from "@aburi/types"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

/**
 * `config.parseTimeoutMs` at the scan boundary: what a timed-out file does to the IR, to
 * `ScanResult.skipped` and `ScanResult.parseTimeouts`, to `stats`, and to the files beside
 * it.
 *
 * The language plugin is the real TypeScript one wrapped in a delay, so the IR that comes
 * out of the surviving files is a real IR and `assertIRIntegrity` runs on it exactly as it
 * does in production. The delay is wall clock genuinely spent rather than a mocked one —
 * the assertions can only fail in the direction of a machine spending more time, which is
 * the direction that keeps them true.
 */

const WARM_SOURCE = "export function warm() {}\n"

let workRoot: string

/**
 * `init()` is a no-op and the plugin defers its WASM and grammar load to the first
 * `parseFile`, which costs about 20 ms against budgets of 100. Discovery hands files over in
 * path order, so without this the file that is meant to *survive* pays that cost whenever it
 * sorts first. Parsing one throwaway file up front takes the term out of every budget below
 * without widening any of them.
 */
beforeAll(async () => {
  const warm = await langTypescriptPlugin.parseFile({ path: "warm.ts", content: WARM_SOURCE })
  // Released here for the same reason the pipeline releases: whoever calls `parseFile`
  // directly owns the tree it hands back, and nothing else will free it.
  if (warm.tree !== null) langTypescriptPlugin.releaseTree(warm.tree)
})

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-parse-timeout-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

/**
 * Spend `ms` of wall clock. The point is that the time is really gone — the counter and the
 * unreachable throw are there so the loop has an observable effect and cannot be optimised,
 * or later "simplified", into nothing.
 */
function spend(ms: number): void {
  const until = performance.now() + ms
  let spins = 0
  while (performance.now() < until) spins++
  if (spins < 0) throw new Error("unreachable")
}

/**
 * The real plugin, with `extractSymbols` slowed for the named files only. Slowing one file
 * and not its neighbour is what shows the budget is charged per file.
 *
 * The plugin is a class instance, so its methods live on the prototype and a spread would
 * copy the fields and lose the behaviour. `Object.create` keeps the original as the
 * prototype and shadows the one method being delayed. That is sound only because the plugin
 * holds no instance state — every method forwards to a module-level function — so `init()`
 * running with `this === wrapped` and `extractSymbols` with `this === base` cannot diverge.
 */
function slowFor(paths: readonly string[], ms: number): LanguagePlugin {
  const slow = new Set(paths)
  const base = langTypescriptPlugin as unknown as LanguagePlugin
  const wrapped: LanguagePlugin = Object.create(base)
  wrapped.extractSymbols = (tree, ctx) => {
    if (slow.has(ctx.file.path)) spend(ms)
    return base.extractSymbols(tree, ctx)
  }
  return wrapped
}

interface RunResult {
  result: ScanResult
  warnings: string[]
}

async function runScan(language: LanguagePlugin, config: Config): Promise<RunResult> {
  const warnings: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message)
    },
    error: () => {},
  }
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  const result = await scan({
    workspaceRoot: workRoot,
    config,
    languages: [language],
    frameworks: [],
    effects: [],
    registry,
    logger,
    components: [],
  })
  return { result, warnings }
}

async function writeSource(rel: string, content: string): Promise<void> {
  await writeFile(join(workRoot, rel), content, "utf8")
}

describe("config.parseTimeoutMs", () => {
  it("keeps a timed-out file out of the IR while its neighbour lands intact", async () => {
    await writeSource("slow.ts", "export function slowOne() { return 1 }\n")
    await writeSource("quick.ts", "export function quickOne() { return 2 }\n")

    const { result } = await runScan(slowFor(["slow.ts"], 250), { parseTimeoutMs: 100 })

    const names = result.ir.symbols.map((s: IRSymbol) => s.name)
    expect(names).toContain("quickOne")
    expect(names).not.toContain("slowOne")
  })

  it("records the file once in skipped, and its numbers on parseTimeouts", async () => {
    await writeSource("slow.ts", "export function slowOne() { return 1 }\n")

    const { result } = await runScan(slowFor(["slow.ts"], 250), { parseTimeoutMs: 100 })

    expect(result.skipped).toHaveLength(1)
    const [entry] = result.skipped
    expect(entry?.path).toBe("slow.ts")
    expect(entry?.reason).toBe("parse-timeout")

    // The numbers live on `parseTimeouts`, not inside the prose — a caller that wants to
    // report how far over the file went should not have to parse a message to find out.
    expect(result.parseTimeouts).toHaveLength(1)
    const [event] = result.parseTimeouts
    expect(event?.file).toBe("slow.ts")
    expect(event?.budgetMs).toBe(100)
    expect(event?.elapsedMs).toBeGreaterThanOrEqual(100)
  })

  it("still reports the parse errors of a file that is broken as well as slow", async () => {
    // Backtracking over malformed input is a common reason for a slow parse, so the two
    // arrive together. Reporting only the budget would send the reader to raise
    // `parseTimeoutMs` when the fix is the syntax.
    await writeSource("broken.ts", "export function ( { { {\n")

    const { result } = await runScan(slowFor(["broken.ts"], 250), { parseTimeoutMs: 100 })

    expect(result.parseTimeouts.map((t) => t.file)).toEqual(["broken.ts"])
    expect(result.parseErrors.map((e) => e.file)).toEqual(["broken.ts"])
    expect(result.parseErrors[0]?.errors.length).toBeGreaterThan(0)
  })

  it("counts the file as discovered but not as parsed", async () => {
    await writeSource("slow.ts", "export function slowOne() { return 1 }\n")
    await writeSource("quick.ts", "export function quickOne() { return 2 }\n")

    const { result } = await runScan(slowFor(["slow.ts"], 250), { parseTimeoutMs: 100 })

    expect(result.ir.stats.totalFiles).toBe(2)
    expect(result.ir.stats.parsedFiles).toBe(1)
  })

  it("warns once, naming the file and the config key that raises the budget", async () => {
    await writeSource("slow.ts", "export function slowOne() { return 1 }\n")

    const { warnings } = await runScan(slowFor(["slow.ts"], 250), { parseTimeoutMs: 100 })

    const timeouts = warnings.filter((w) => w.includes("parseTimeoutMs"))
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0]).toContain("slow.ts")
  })

  it("drops the timed-out file's imports, so nothing resolves into it", async () => {
    await writeSource("slow.ts", "export function target() { return 1 }\n")
    await writeSource(
      "caller.ts",
      'import { target } from "./slow"\nexport function caller() { return target() }\n',
    )

    const { result } = await runScan(slowFor(["slow.ts"], 250), { parseTimeoutMs: 100 })

    expect(result.ir.dependencies).toEqual([])
    const caller = result.ir.symbols.find((s: IRSymbol) => s.name === "caller")
    expect(caller?.calls.every((c: { resolved: string | null }) => c.resolved === null)).toBe(true)
  })

  it("starts a fresh budget for the file after a timed-out one", async () => {
    // Discovery hands files over in path order, so the slow one is scanned first and has
    // already blown the budget by the time the quick one starts. A budget charged across
    // the run rather than per file would take the second file down with the first.
    //
    // Both margins here are wide on purpose: the slow file is over by 150 ms and the quick
    // one spends nothing, so neither direction turns on how loaded the machine is.
    await writeSource("a-slow.ts", "export function slowOne() { return 1 }\n")
    await writeSource("z-quick.ts", "export function quickOne() { return 2 }\n")

    const { result } = await runScan(slowFor(["a-slow.ts"], 250), { parseTimeoutMs: 100 })

    expect(result.skipped.map((s) => s.path)).toEqual(["a-slow.ts"])
    expect(result.ir.symbols.map((s: IRSymbol) => s.name)).toEqual(["quickOne"])
  })

  it("leaves an ordinary scan alone when no file is near the budget", async () => {
    await writeSource("quick.ts", "export function quickOne() { return 2 }\n")

    const { result, warnings } = await runScan(langTypescriptPlugin, { parseTimeoutMs: 600_000 })

    expect(result.skipped).toEqual([])
    expect(result.parseTimeouts).toEqual([])
    expect(warnings).toEqual([])
    expect(result.ir.symbols.map((s: IRSymbol) => s.name)).toEqual(["quickOne"])
  })
})
