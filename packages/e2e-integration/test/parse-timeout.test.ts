import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { Config, LanguagePlugin } from "@aburi/types"
import { beforeAll, describe, expect, it } from "vitest"
import { scanWith, type WarningCollector, warningCollector } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * `config.parseTimeoutMs` at the scan boundary: what a timed-out file does to the IR, to
 * `ScanResult.skipped` and `ScanResult.parseTimeouts`, to `stats`, and to the files beside
 * it.
 *
 * The language plugin is the real TypeScript one wrapped in a delay, so the IR that comes
 * out of the surviving files is a real IR and `assertIRIntegrity` runs on it exactly as it
 * does in production. The delay is wall clock genuinely spent rather than a mocked one, so
 * the budget has to clear two different margins and only one of them is self-correcting. A
 * slow machine keeps "the slow file times out" true, because more time spent is the side
 * that trips the budget. It works against "its neighbour survives": the undelayed file is
 * charged real parse time, and a runner that stalls inside it blows a budget that has
 * nothing to do with the delay under test. That is not a margin to shave — this suite has
 * failed on a loaded Windows runner with an empty IR, both files timed out — so the budget
 * is 500 ms against a parse that costs single-digit milliseconds warm, and the delay is
 * scaled with it to keep the ratio the assertions rest on.
 */

const workspace = useScratchWorkspace("parse-timeout")

/**
 * The plugin defers its WASM and grammar load to the first `parseFile`, which costs about
 * 20 ms against budgets of 500. Discovery hands files over in path order, so without this
 * the file that is meant to *survive* pays that cost whenever it sorts first.
 */
beforeAll(async () => {
  const warm = await langTypescriptPlugin.parseFile({
    path: "warm.ts",
    content: "export function warm() {}\n",
  })
  // Whoever calls `parseFile` directly owns the tree it hands back.
  if (warm.tree !== null) langTypescriptPlugin.releaseTree(warm.tree)
})

/**
 * Spend `ms` of wall clock. The counter and the unreachable throw give the loop an
 * observable effect so it cannot be optimised, or later "simplified", into nothing.
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
 * lose them. `Object.create` keeps the original as the prototype and shadows the one method
 * being delayed; that is sound because the plugin holds no instance state.
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

async function runScan(language: LanguagePlugin, config: Config) {
  const collector: WarningCollector = warningCollector()
  const result = await scanWith(workspace.root, { languages: [language] }, config, {
    logger: collector.logger,
  })
  return { result, warnings: collector.warnings }
}

describe("config.parseTimeoutMs", () => {
  it("keeps a timed-out file out of the IR while its neighbour lands intact", async () => {
    await workspace.writeSource("slow.ts", "export function slowOne() { return 1 }\n")
    await workspace.writeSource("quick.ts", "export function quickOne() { return 2 }\n")

    const { result } = await runScan(slowFor(["slow.ts"], 1250), { parseTimeoutMs: 500 })

    const names = result.ir.symbols.map((symbol) => symbol.name)
    expect(names).toContain("quickOne")
    expect(names).not.toContain("slowOne")
  })

  it("records the file once in skipped, and its numbers on parseTimeouts", async () => {
    await workspace.writeSource("slow.ts", "export function slowOne() { return 1 }\n")

    const { result } = await runScan(slowFor(["slow.ts"], 1250), { parseTimeoutMs: 500 })

    expect(result.skipped).toHaveLength(1)
    const [entry] = result.skipped
    expect(entry?.path).toBe("slow.ts")
    expect(entry?.reason).toBe("parse-timeout")

    // The numbers live on `parseTimeouts`, not inside the prose — a caller that wants to
    // report how far over the file went should not have to parse a message to find out.
    expect(result.parseTimeouts).toHaveLength(1)
    const [event] = result.parseTimeouts
    expect(event?.file).toBe("slow.ts")
    expect(event?.budgetMs).toBe(500)
    expect(event?.elapsedMs).toBeGreaterThanOrEqual(500)
  })

  it("still reports the parse errors of a file that is broken as well as slow", async () => {
    // Backtracking over malformed input is a common reason for a slow parse, so the two
    // arrive together. Reporting only the budget would send the reader to raise
    // `parseTimeoutMs` when the fix is the syntax.
    await workspace.writeSource("broken.ts", "export function ( { { {\n")

    const { result } = await runScan(slowFor(["broken.ts"], 1250), { parseTimeoutMs: 500 })

    expect(result.parseTimeouts.map((t) => t.file)).toEqual(["broken.ts"])
    expect(result.parseErrors.map((e) => e.file)).toEqual(["broken.ts"])
    expect(result.parseErrors[0]?.errors.length).toBeGreaterThan(0)
  })

  it("counts the file as discovered but not as parsed", async () => {
    await workspace.writeSource("slow.ts", "export function slowOne() { return 1 }\n")
    await workspace.writeSource("quick.ts", "export function quickOne() { return 2 }\n")

    const { result } = await runScan(slowFor(["slow.ts"], 1250), { parseTimeoutMs: 500 })

    expect(result.ir.stats.totalFiles).toBe(2)
    expect(result.ir.stats.parsedFiles).toBe(1)
  })

  it("warns once, naming the file and the config key that raises the budget", async () => {
    await workspace.writeSource("slow.ts", "export function slowOne() { return 1 }\n")

    const { warnings } = await runScan(slowFor(["slow.ts"], 1250), { parseTimeoutMs: 500 })

    const timeouts = warnings.filter((w) => w.includes("parseTimeoutMs"))
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0]).toContain("slow.ts")
  })

  it("drops the timed-out file's imports, so nothing resolves into it", async () => {
    await workspace.writeSource("slow.ts", "export function target() { return 1 }\n")
    await workspace.writeSource(
      "caller.ts",
      'import { target } from "./slow"\nexport function caller() { return target() }\n',
    )

    const { result } = await runScan(slowFor(["slow.ts"], 1250), { parseTimeoutMs: 500 })

    expect(result.ir.dependencies).toEqual([])
    const caller = result.ir.symbols.find((symbol) => symbol.name === "caller")
    expect(caller?.calls.every((c) => c.resolved === null)).toBe(true)
  })

  it("starts a fresh budget for the file after a timed-out one", async () => {
    // Discovery hands files over in path order, so the slow one is scanned first and has
    // already blown the budget by the time the quick one starts. A budget charged across
    // the run rather than per file would take the second file down with the first.
    //
    // Both margins are wide on purpose: the slow file is over by 750 ms, and the quick one
    // spends nothing beyond its own parse against a budget two orders of magnitude larger.
    await workspace.writeSource("a-slow.ts", "export function slowOne() { return 1 }\n")
    await workspace.writeSource("z-quick.ts", "export function quickOne() { return 2 }\n")

    const { result } = await runScan(slowFor(["a-slow.ts"], 1250), { parseTimeoutMs: 500 })

    expect(result.skipped.map((s) => s.path)).toEqual(["a-slow.ts"])
    expect(result.ir.symbols.map((symbol) => symbol.name)).toEqual(["quickOne"])
  })

  it("leaves an ordinary scan alone when no file is near the budget", async () => {
    await workspace.writeSource("quick.ts", "export function quickOne() { return 2 }\n")

    const { result, warnings } = await runScan(langTypescriptPlugin, { parseTimeoutMs: 600_000 })

    expect(result.skipped).toEqual([])
    expect(result.parseTimeouts).toEqual([])
    expect(warnings).toEqual([])
    expect(result.ir.symbols.map((symbol) => symbol.name)).toEqual(["quickOne"])
  })
})
