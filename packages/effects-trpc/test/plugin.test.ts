import { makeCall, makeCtx, noopRegistry, silentLogger } from "@aburi/test-support"
import type { EffectPlugin, PluginContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { effectsTrpcManifest, TrpcEffectsPlugin, trpcEffectsPlugin } from "../src/index"
import { makeTrpcClientImport } from "./fixtures/context"

const testPluginContext: PluginContext = {
  registry: noopRegistry,
  config: {},
  workspaceRoot: "/tmp",
  log: silentLogger,
}

describe("TrpcEffectsPlugin", () => {
  it("exposes the effects-trpc manifest", () => {
    expect(trpcEffectsPlugin.manifest).toBe(effectsTrpcManifest)
  })

  it("init resolves without touching plugin state", async () => {
    await expect(trpcEffectsPlugin.init(testPluginContext)).resolves.toBeUndefined()
  })

  it("dispatches classify() to the pure classifier, from the class and the singleton alike", () => {
    const ctx = makeCtx({ imports: [makeTrpcClientImport()] })
    const call = makeCall({ target: "client.user.create.mutate", argumentCount: 1 })
    const result = trpcEffectsPlugin.classify(call, ctx)
    expect(result?.effectId).toBe("network.rpc")
    expect(new TrpcEffectsPlugin().classify(call, ctx)).toEqual(result)
  })

  it("returns null when the file is not a tRPC client consumer", () => {
    const ctx = makeCtx({ imports: [] })
    expect(
      trpcEffectsPlugin.classify(makeCall({ target: "client.user.byId.query" }), ctx),
    ).toBeNull()
  })

  it("satisfies the EffectPlugin contract and declares no dropCallees", () => {
    const asEffectPlugin: EffectPlugin = trpcEffectsPlugin
    expect(asEffectPlugin.dropCallees).toBeUndefined()
  })
})
