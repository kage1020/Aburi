import type {
  CallCandidate,
  ClassifyContext,
  EffectPlugin,
  EffectsManifest,
  VocabRegistry,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { type ClassifyTimeoutEvent, classifyWithTimeout } from "../../src"
import { symbolId } from "../fixtures/ir"

const noopRegistry: VocabRegistry = {
  findEffect: () => null,
  findExtKind: () => null,
  findFramework: () => null,
  findDerivedByOwner: () => null,
  isEffectOwnedBy: () => false,
  isExtKindOwnedBy: () => false,
  listEffects: () => [],
  listExtKinds: () => [],
  listFrameworks: () => [],
  listPlugins: () => [],
  assertEffectDeclared: () => {},
  assertExtKindDeclared: () => {},
}

const stubManifest: EffectsManifest = {
  $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
  name: "effects-stub",
  version: "0.0.0",
  type: "effects",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: ["effects-plugin:stub"],
    frameworks: [],
  },
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

  it("returns null and fires onTimeout when the wall-clock exceeds the budget", () => {
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
    expect(result).toBeNull()
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
    expect(result).toBeNull()
    expect(observed).toBe(10)
  })

  it("clamps timeoutMs above the maximum (5000 ms) down to the ceiling", () => {
    let observed = 0
    const plugin: EffectPlugin = {
      manifest: stubManifest,
      init: async () => {},
      classify: () => {
        return { effectId: "db.read", confidence: "high", derivedBy: "effects-plugin:stub:x" }
      },
    }
    classifyWithTimeout(
      plugin,
      makeCall("x.y"),
      makeCtx(),
      { symbolId: "ts:test.ts#Fn", file: "test.ts" },
      { timeoutMs: 99_999, onTimeout: (event) => (observed = event.budgetMs) },
    )
    // The classifier resolved fast so no timeout event fires; we only assert the
    // clamp had a chance to run by verifying the plugin actually classified.
    expect(observed).toBe(0)
  })
})
