import { makeCall, makeCtx, spend } from "@aburi/test-support"
import type { EffectClassification, EffectPlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  CLASSIFY_TIMEOUT_MIN_MS,
  type ClassifyTimeoutEvent,
  type ClassifyWithTimeoutOptions,
  CoreError,
  classifyWithTimeout,
} from "../../src"
import { stubEffectsPlugin } from "../fixtures/plugins"

const READ: EffectClassification = { effectId: "db.read", confidence: "high", derivedBy: "stub:x" }

function slowPlugin(ms: number): EffectPlugin {
  return stubEffectsPlugin("effects-stub", () => {
    spend(ms)
    return READ
  })
}

function classify(plugin: EffectPlugin, options: ClassifyWithTimeoutOptions = {}) {
  return classifyWithTimeout(
    plugin,
    makeCall({ target: "slow.op", line: 3 }),
    makeCtx(),
    { symbolId: "ts:test.ts#Fn", file: "test.ts" },
    options,
  )
}

describe("classifyWithTimeout", () => {
  it("passes the classification through when the classifier finishes inside its budget", () => {
    expect(classify(slowPlugin(0))).toEqual(READ)
  })

  it("answers null and reports the plugin, the call and the budget when the classifier overruns", () => {
    const events: ClassifyTimeoutEvent[] = []
    const result = classify(slowPlugin(80), { timeoutMs: 50, onTimeout: (e) => events.push(e) })

    expect(result).toBeNull()
    expect(events).toEqual([
      {
        plugin: "effects-stub",
        symbolId: "ts:test.ts#Fn",
        target: "slow.op",
        file: "test.ts",
        line: 3,
        budgetMs: 50,
        elapsedMs: expect.any(Number),
      },
    ])
    expect(events[0]?.elapsedMs).toBeGreaterThan(50)
  })

  it("raises a budget below the minimum to the minimum", () => {
    const events: ClassifyTimeoutEvent[] = []
    const result = classify(slowPlugin(CLASSIFY_TIMEOUT_MIN_MS + 10), {
      timeoutMs: 1,
      onTimeout: (e) => events.push(e),
    })
    expect(result).toBeNull()
    expect(events.map((e) => e.budgetMs)).toEqual([CLASSIFY_TIMEOUT_MIN_MS])
  })

  it("refuses a classifier that returns a Promise, before any timeout is reported", () => {
    const events: ClassifyTimeoutEvent[] = []
    const plugin = stubEffectsPlugin("effects-async", (() => Promise.resolve(null)) as never)

    expect(() => classify(plugin, { onTimeout: (e) => events.push(e) })).toThrow(CoreError)
    expect(() => classify(plugin)).toThrow(/sync contract/)
    expect(events).toEqual([])
  })

  it("leaves no rejection unhandled when the Promise a classifier returned rejects", async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", record)
    try {
      const plugin = stubEffectsPlugin("effects-async", (() =>
        Promise.reject(new Error("classifier failed"))) as never)
      expect(() => classify(plugin)).toThrow(CoreError)
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off("unhandledRejection", record)
    }
    expect(unhandled).toEqual([])
  })
})
