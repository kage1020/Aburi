import { scanWith } from "@aburi/test-harness"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { beforeAll, describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/index"
import { pluginOverriding } from "./fixtures/scan"

const workspace = useScratchWorkspace("parse-timeout")

const BUDGET_MS = 500
const OVERRUN_MS = 1250

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

/** A scan in which extracting `slow` runs past the parse budget. */
async function scanOverrunning(slow: string) {
  const plugin = pluginOverriding((real) => ({
    extractSymbols: (tree, ctx) => {
      if (ctx.file.path === slow) spend(OVERRUN_MS)
      return real.extractSymbols(tree, ctx)
    },
  }))
  const logger = recordingLogger()
  const result = await scanWith(
    workspace.root,
    { languages: [plugin] },
    { parseTimeoutMs: BUDGET_MS },
    { logger },
  )
  return { result, warnings: logger.warnings }
}

describe("config.parseTimeoutMs", () => {
  it("keeps a timed-out file out of the IR, and gives the file after it a budget of its own", async () => {
    await workspace.writeSource("a-slow.ts", "export function slowOne() { return 1 }\n")
    await workspace.writeSource("z-quick.ts", "export function quickOne() { return 2 }\n")

    const { result } = await scanOverrunning("a-slow.ts")

    expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([["a-slow.ts", "parse-timeout"]])
    expect(result.ir.symbols.map((symbol) => symbol.name)).toEqual(["quickOne"])
  })

  it("warns once, naming the file and the config key that raises the budget", async () => {
    await workspace.writeSource("slow.ts", "export function slowOne() { return 1 }\n")

    const { warnings } = await scanOverrunning("slow.ts")

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

    const { result } = await scanOverrunning("slow.ts")

    expect(result.ir.dependencies).toEqual([])
    const caller = result.ir.symbols.find((symbol) => symbol.name === "caller")
    expect(caller?.calls.every((c) => c.resolved === null)).toBe(true)
  })
})
