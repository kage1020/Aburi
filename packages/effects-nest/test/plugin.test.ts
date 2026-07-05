import type { EffectPlugin, PluginContext, VocabRegistry } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { NestEffectsPlugin, nestEffectsPlugin } from "../src/index"
import { makeCall, makeCtx, makeNestEmitterImport, noopRegistry } from "./fixtures/context"

const testPluginContext: PluginContext = {
  registry: noopRegistry as VocabRegistry,
  config: {},
  workspaceRoot: "/tmp",
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}

describe("NestEffectsPlugin", () => {
  it("exposes the effects-nest manifest", () => {
    expect(nestEffectsPlugin.manifest.name).toBe("effects-nest")
    expect(nestEffectsPlugin.manifest.type).toBe("effects")
  })

  it("init resolves without touching plugin state", async () => {
    await expect(nestEffectsPlugin.init(testPluginContext)).resolves.toBeUndefined()
  })

  it("dispatches classify() to the pure classifier", () => {
    const ctx = makeCtx({ imports: [makeNestEmitterImport()] })
    const result = nestEffectsPlugin.classify(makeCall({ target: "eventBus.emit" }), ctx)
    expect(result?.effectId).toBe("event.publish")
  })

  it("returns null when the file is not a Nest emitter consumer", () => {
    const ctx = makeCtx({ imports: [] })
    expect(nestEffectsPlugin.classify(makeCall({ target: "eventBus.emit" }), ctx)).toBeNull()
  })

  it("class and singleton share behavior", () => {
    const constructed = new NestEffectsPlugin()
    const ctx = makeCtx({ imports: [makeNestEmitterImport()] })
    const call = makeCall({ target: "this.eventBus.emit" })
    expect(constructed.classify(call, ctx)).toEqual(nestEffectsPlugin.classify(call, ctx))
  })

  it("classify is idempotent across repeated invocations (no per-call state)", () => {
    const ctx = makeCtx({ imports: [makeNestEmitterImport()] })
    const call = makeCall({ target: "EventEmitter2.emit" })
    const runs = Array.from({ length: 5 }, () => nestEffectsPlugin.classify(call, ctx))
    for (const r of runs) expect(r).toEqual(runs[0])
  })

  it("does not declare dropCallees (Nest logger is DI'd per provider)", () => {
    // Access through the EffectPlugin lens because the class narrow type omits the
    // optional field entirely — the absence at runtime is exactly what we assert.
    const asInterface: EffectPlugin = nestEffectsPlugin
    expect(asInterface.dropCallees).toBeUndefined()
  })
})
