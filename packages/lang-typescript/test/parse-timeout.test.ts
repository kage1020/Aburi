import { scanWith } from "@aburi/test-harness"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type { Config, LanguagePlugin } from "@aburi/types"
import { beforeAll, describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/index"

const workspace = useScratchWorkspace("parse-timeout")

beforeAll(async () => {
  const warm = await langTypescriptPlugin.parseFile({
    path: "warm.ts",
    content: "export function warm() {}\n",
  })
  // Whoever calls `parseFile` directly owns the tree it hands back.
  if (warm.tree !== null) langTypescriptPlugin.releaseTree(warm.tree)
})

function spend(ms: number): void {
  const until = performance.now() + ms
  let spins = 0
  while (performance.now() < until) spins++
  if (spins < 0) throw new Error("unreachable")
}

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
  const logger = recordingLogger()
  const result = await scanWith(workspace.root, { languages: [language] }, config, {
    logger,
  })
  return { result, warnings: logger.warnings }
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

    expect(result.parseTimeouts).toHaveLength(1)
    const [event] = result.parseTimeouts
    expect(event?.file).toBe("slow.ts")
    expect(event?.budgetMs).toBe(500)
    expect(event?.elapsedMs).toBeGreaterThanOrEqual(500)
  })

  it("still reports the parse errors of a file that is broken as well as slow", async () => {
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
