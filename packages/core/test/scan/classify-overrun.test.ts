import { makeCall, spend, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import {
  scanStubs,
  stubCandidate,
  stubEffectsPlugin,
  stubLanguagePlugin,
} from "../fixtures/plugins"

const CALLER = "stub:app.stub#caller"
const CALLEE = "stub:app.stub#callee"

const workspace = useScratchWorkspace("classify-overrun")

beforeEach(async () => {
  await workspace.writeSource("app.stub", "app")
})

/** `caller` calls `callee`, which calls `db.query`. */
const language = stubLanguagePlugin({
  extractSymbols: () => [
    stubCandidate("caller", { file: "app.stub" }),
    stubCandidate("callee", { file: "app.stub" }),
  ],
  walkBody: (candidate) => ({
    rules: [],
    calls: [makeCall({ target: candidate.name === "caller" ? "callee" : "db.query", line: 2 })],
  }),
})

function scanSpending(ms: number, classifyTimeoutMs: number) {
  const slowReads = stubEffectsPlugin("effects-slow", (call) => {
    if (call.target !== "db.query") return null
    spend(ms)
    return { effectId: "db.read", confidence: "high", derivedBy: "effects-slow:query" }
  })
  return scanStubs(workspace.root, {
    config: { classifyTimeoutMs },
    languages: [language],
    effects: [slowReads],
  })
}

describe("scan — a classification that ran past its budget", () => {
  it("changes stats.effectClassifyTimeouts and nothing else in the Document", async () => {
    // 30 ms against the 10 ms floor overruns on any machine; 0 ms against 5000 ms does not.
    const slow = await scanSpending(30, 10)
    const fast = await scanSpending(0, 5000)

    // Two Documents that both lost the effect would compare equal too; the fast one has it.
    const caller = fast.ir.symbols.find((symbol) => symbol.id === CALLER)
    expect(caller?.effects).toEqual([
      expect.objectContaining({ id: "db.read", target: "db.query", propagated: true }),
    ])
    expect(fast.ir.stats.effectClassifyTimeouts).toBeUndefined()

    // `caller`'s own call is timed against the same 10 ms, so it may overrun too.
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
    const { timeoutEvents } = await scanSpending(30, 10)

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
