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

  it("classify is idempotent across repeated invocations (no per-call state)", () => {
    const ctx = makeCtx({ imports: [makeTrpcClientImport("@trpc/react-query")] })
    const call = makeCall({ target: "trpc.post.list.useQuery" })
    const runs = Array.from({ length: 5 }, () => trpcEffectsPlugin.classify(call, ctx))
    for (const run of runs) expect(run).toEqual(runs[0])
  })

  it("satisfies the EffectPlugin contract and declares no dropCallees", () => {
    // Widened to the interface because the narrow class type omits the optional field.
    const asEffectPlugin: EffectPlugin = trpcEffectsPlugin
    expect(asEffectPlugin.dropCallees).toBeUndefined()
  })
})
