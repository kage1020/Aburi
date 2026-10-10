import { makeCall, makeCtx, noopRegistry, silentLogger } from "@aburi/test-support"
import type { EffectPlugin, PluginContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { effectsNestManifest, NestEffectsPlugin, nestEffectsPlugin } from "../src/index"
import { makeNestEmitterImport } from "./fixtures/context"

const testPluginContext: PluginContext = {
  registry: noopRegistry,
  config: {},
  workspaceRoot: "/tmp",
  log: silentLogger,
}

describe("NestEffectsPlugin", () => {
  it("exposes the effects-nest manifest", () => {
    expect(nestEffectsPlugin.manifest).toBe(effectsNestManifest)
  })

  it("init resolves without touching plugin state", async () => {
    await expect(nestEffectsPlugin.init(testPluginContext)).resolves.toBeUndefined()
  })

  it("dispatches classify() to the pure classifier, from the class and the singleton alike", () => {
    const ctx = makeCtx({ imports: [makeNestEmitterImport()] })
    const call = makeCall({ target: "this.eventBus.emit" })
    const result = nestEffectsPlugin.classify(call, ctx)
    expect(result?.effectId).toBe("event.publish")
    expect(new NestEffectsPlugin().classify(call, ctx)).toEqual(result)
  })

  it("returns null when the file is not a Nest emitter consumer", () => {
    const ctx = makeCtx({ imports: [] })
    expect(nestEffectsPlugin.classify(makeCall({ target: "eventBus.emit" }), ctx)).toBeNull()
  })

  it("does not declare dropCallees (Nest logger is DI'd per provider)", () => {
    const asInterface: EffectPlugin = nestEffectsPlugin
    expect(asInterface.dropCallees).toBeUndefined()
  })
})
