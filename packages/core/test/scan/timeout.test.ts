import { noopRegistry } from "@aburi/test-support"
import type { CallCandidate, ClassifyContext, EffectPlugin, EffectsManifest } from "@aburi/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ClassifyTimeoutEvent, classifyWithTimeout } from "../../src"
import { symbolId } from "../fixtures/ir"
import { effectsManifest } from "../fixtures/plugins"

const stubManifest: EffectsManifest = {
  ...effectsManifest(),
  provides: { ...effectsManifest().provides, derivedByPrefixes: ["effects-plugin:stub"] },
}

function makeCall(target: string): CallCandidate {
  return { target, line: 3, argumentCount: 0, inAwait: false, inNew: false, literalArgs: [] }
}

function makeCtx(): ClassifyContext {
  return {
    owner: {
      id: symbolId("ts:test.ts#Fn"),
      kind: "function",
      name: "Fn",
      extKind: null,
      decorators: [],
      component: null,
    },
    file: { path: "test.ts", imports: [] },
    language: "ts",
    registry: noopRegistry,
    config: {},
  }
}

describe("classifyWithTimeout", () => {
  it("passes through the classification when the classifier finishes on time", () => {
    const plugin: EffectPlugin = {
      manifest: stubManifest,
      init: async () => {},
      classify: () => ({
        effectId: "db.read",
        confidence: "high",
        derivedBy: "effects-plugin:stub:x",
      }),
    }
    const result = classifyWithTimeout(plugin, makeCall("foo.bar"), makeCtx(), {
      symbolId: "ts:test.ts#Fn",
      file: "test.ts",
    })
    expect(result?.effectId).toBe("db.read")
  })

  it("keeps the classification and fires onTimeout when the wall-clock exceeds the budget", () => {
    // The answer was already computed when the clock was read. Dropping it saved no time and
    // made the IR depend on the machine: a cold first call lost its effect on a busy runner.
    const plugin: EffectPlugin = {
      manifest: stubManifest,
      init: async () => {},
      classify: () => {
        const start = performance.now()
        while (performance.now() - start < 80) {
          /* busy-wait past the budget */
        }
        return { effectId: "db.read", confidence: "high", derivedBy: "effects-plugin:stub:x" }
      },
    }
    const events: ClassifyTimeoutEvent[] = []
    const result = classifyWithTimeout(
      plugin,
      makeCall("slow.op"),
      makeCtx(),
      { symbolId: "ts:test.ts#Fn", file: "test.ts" },
      { timeoutMs: 50, onTimeout: (event) => events.push(event) },
    )
    expect(result).toEqual({
      effectId: "db.read",
      confidence: "high",
      derivedBy: "effects-plugin:stub:x",
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.plugin).toBe("effects-stub")
    expect(events[0]?.symbolId).toBe("ts:test.ts#Fn")
    expect(events[0]?.target).toBe("slow.op")
    expect(events[0]?.budgetMs).toBe(50)
    expect(events[0]?.elapsedMs).toBeGreaterThan(50)
  })

  it("throws CoreError when the classifier violates the sync contract by returning a Promise", () => {
    const plugin: EffectPlugin = {
      manifest: stubManifest,
      init: async () => {},
      classify: (() => Promise.resolve(null)) as never,
    }
    const events: ClassifyTimeoutEvent[] = []
    expect(() =>
      classifyWithTimeout(
        plugin,
        makeCall("bad.op"),
        makeCtx(),
        { symbolId: "ts:test.ts#Fn", file: "test.ts" },
        { onTimeout: (event) => events.push(event) },
      ),
    ).toThrow(/sync contract/)
    // The throw pre-empts onTimeout — the timeout event list stays empty.
    expect(events).toHaveLength(0)
  })

  it("clamps timeoutMs below the minimum (10 ms) up to the floor before comparing", () => {
    let observed = 0
    const plugin: EffectPlugin = {
      manifest: stubManifest,
      init: async () => {},
      classify: () => {
        const start = performance.now()
        while (performance.now() - start < 20) {
          /* burn past the clamped budget */
        }
        return { effectId: "db.read", confidence: "high", derivedBy: "effects-plugin:stub:x" }
      },
    }
    const result = classifyWithTimeout(
      plugin,
      makeCall("x.y"),
      makeCtx(),
      { symbolId: "ts:test.ts#Fn", file: "test.ts" },
      { timeoutMs: 1, onTimeout: (event) => (observed = event.budgetMs) },
    )
    expect(result?.effectId).toBe("db.read")
    expect(observed).toBe(10)
  })

  describe("clamps timeoutMs above the maximum (5000 ms) down to the ceiling", () => {
    // The clock is faked here, unlike everywhere else in these tests, because what is under test
    // is the arithmetic of the clamp and not the timing mechanism, and spending five real seconds
    // to reach the ceiling would buy nothing. Both sides of the bound are pinned.
    afterEach(() => {
      vi.useRealTimers()
    })

    function classifyTaking(ms: number): ClassifyTimeoutEvent[] {
      vi.useFakeTimers({ toFake: ["performance"] })
      const plugin: EffectPlugin = {
        manifest: stubManifest,
        init: async () => {},
        classify: () => {
          vi.advanceTimersByTime(ms)
          return { effectId: "db.read", confidence: "high", derivedBy: "effects-plugin:stub:x" }
        },
      }
      const events: ClassifyTimeoutEvent[] = []
      classifyWithTimeout(
        plugin,
        makeCall("x.y"),
        makeCtx(),
        { symbolId: "ts:test.ts#Fn", file: "test.ts" },
        { timeoutMs: 99_999, onTimeout: (event) => events.push(event) },
      )
      return events
    }

    it("reports a call one millisecond past the ceiling, against the ceiling", () => {
      expect(classifyTaking(5001).map((event) => event.budgetMs)).toEqual([5000])
    })

    it("does not report a call that took exactly the ceiling", () => {
      expect(classifyTaking(5000)).toEqual([])
    })
  })
})
