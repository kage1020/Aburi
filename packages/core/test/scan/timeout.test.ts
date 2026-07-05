import type {
  CallCandidate,
  ClassifyContext,
  EffectPlugin,
  EffectsManifest,
  VocabRegistry,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { type ClassifyTimeoutEvent, classifyWithTimeout } from "../../src"

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
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
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
      id: "ts:test.ts#Fn",
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
    const result = classifyWithTimeout(plugin, makeCall("foo.bar"), makeCtx(), "test.ts")
    expect(result?.effectId).toBe("db.read")
  })

  it("returns null and fires onTimeout when the wall-clock exceeds the budget", () => {
    const plugin: EffectPlugin = {
      manifest: stubManifest,
      init: async () => {},
      classify: () => {
        // Busy-wait past the default (50 ms) budget.
        const start = performance.now()
        while (performance.now() - start < 80) {
          // deliberate spin
        }
        return { effectId: "db.read", confidence: "high", derivedBy: "effects-plugin:stub:x" }
      },
    }
    const events: ClassifyTimeoutEvent[] = []
    const result = classifyWithTimeout(plugin, makeCall("slow.op"), makeCtx(), "test.ts", {
      timeoutMs: 50,
      onTimeout: (event) => events.push(event),
    })
    expect(result).toBeNull()
    expect(events).toHaveLength(1)
    expect(events[0]?.plugin).toBe("effects-stub")
    expect(events[0]?.target).toBe("slow.op")
    expect(events[0]?.elapsedMs).toBeGreaterThan(50)
  })

  it("returns null and fires onTimeout when the classifier violates the sync contract", () => {
    const plugin: EffectPlugin = {
      manifest: stubManifest,
      init: async () => {},
      // The declared signature is sync but the implementation returns a Promise —
      // treat it as a soft timeout so the scan does not stall.
      classify: (() => Promise.resolve(null)) as never,
    }
    const events: ClassifyTimeoutEvent[] = []
    const result = classifyWithTimeout(plugin, makeCall("bad.op"), makeCtx(), "test.ts", {
      onTimeout: (event) => events.push(event),
    })
    expect(result).toBeNull()
    expect(events).toHaveLength(1)
  })
})
