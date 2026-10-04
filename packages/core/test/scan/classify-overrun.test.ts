import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noopRegistry } from "@aburi/test-support"
import type { BodyExtraction, EffectPlugin, OpaqueAstNode, SymbolCandidate } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scan } from "../../src"
import { spend } from "../fixtures/clock"
import { effectsManifest, stubCandidate, stubLanguagePlugin } from "../fixtures/plugins"

/**
 * EP13 through `scan()`: a classification that ran past its budget is kept, so the overrun
 * reaches `stats.effectClassifyTimeouts` and nothing else in the Document. Not the Symbol that
 * made the call, and not the caller its effect propagates to, whose `logic` is recomputed after
 * propagation and would move if the effect were lost.
 */

const CALLER = "stub:app.stub#caller"
const CALLEE = "stub:app.stub#callee"

/** `caller` calls `callee`, which calls `db.query`. */
const language = stubLanguagePlugin({
  extractSymbols: () => [
    stubCandidate("caller", { file: "app.stub" }),
    stubCandidate("callee", { file: "app.stub" }),
  ],
  walkBody: (candidate: SymbolCandidate<OpaqueAstNode>): BodyExtraction => ({
    rules: [],
    calls: [
      {
        target: candidate.name === "caller" ? "callee" : "db.query",
        line: 2,
        argumentCount: 0,
        inAwait: false,
        inNew: false,
        literalArgs: [],
      },
    ],
  }),
})

/** Spends `ms` of real time on `db.query` and classifies it as a read; leaves `callee` alone. */
function effects(ms: number): EffectPlugin {
  return {
    manifest: effectsManifest("effects-slow"),
    init: async () => {},
    classify: (call) => {
      if (call.target !== "db.query") return null
      spend(ms)
      return { effectId: "db.read", confidence: "high", derivedBy: "effects-slow:query" }
    },
  }
}

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-classify-overrun-"))
  await writeFile(join(workRoot, "app.stub"), "app", "utf8")
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

function scanWith(classifyTimeoutMs: number, ms: number) {
  return scan({
    workspaceRoot: workRoot,
    config: { classifyTimeoutMs },
    languages: [language],
    frameworks: [],
    effects: [effects(ms)],
    registry: noopRegistry,
  })
}

describe("scan() — a classification past its budget (EP13)", () => {
  it("changes stats.effectClassifyTimeouts and nothing else in the Document", async () => {
    // 30 ms against the 10 ms floor overruns on any machine; 0 ms against 5000 ms does not.
    const slow = await scanWith(10, 30)
    const fast = await scanWith(5000, 0)

    // The fast Document has the effect and its propagation, so the comparison below is not
    // between two Documents that both lost it.
    const caller = fast.ir.symbols.find((symbol) => symbol.id === CALLER)
    expect(caller?.effects).toEqual([
      expect.objectContaining({ id: "db.read", target: "db.query", propagated: true }),
    ])
    expect(fast.ir.stats.effectClassifyTimeouts).toBeUndefined()

    // `toContainEqual`, not `toEqual`: `caller`'s own call is timed against the same 10 ms, and
    // a test saying it stayed under would be the two-sided kind `spend` warns about.
    expect(slow.ir.stats.effectClassifyTimeouts).toContainEqual({
      plugin: "effects-slow",
      symbolId: CALLEE,
      timeoutMs: 10,
    })
    expect(slow.ir).toEqual({
      ...fast.ir,
      stats: { ...fast.ir.stats, effectClassifyTimeouts: slow.ir.stats.effectClassifyTimeouts },
    })
  })

  it("keeps the call and the wall clock, which the IR record leaves out, on timeoutEvents", async () => {
    const { timeoutEvents } = await scanWith(10, 30)

    const event = timeoutEvents.find((e) => e.symbolId === CALLEE)
    expect(event).toMatchObject({
      plugin: "effects-slow",
      target: "db.query",
      file: "app.stub",
      line: 2,
      budgetMs: 10,
    })
    expect(event?.elapsedMs).toBeGreaterThanOrEqual(30)
  })
})
