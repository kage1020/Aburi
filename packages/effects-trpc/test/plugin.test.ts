import type { EffectPlugin, PluginContext, VocabRegistry } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { TrpcEffectsPlugin, trpcEffectsPlugin } from "../src/index"
import { makeCall, makeCtx, makeTrpcClientImport, noopRegistry } from "./fixtures/context"

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

describe("TrpcEffectsPlugin", () => {
  it("exposes the effects-trpc manifest", () => {
    expect(trpcEffectsPlugin.manifest.name).toBe("effects-trpc")
    expect(trpcEffectsPlugin.manifest.type).toBe("effects")
  })

  it("init resolves without touching plugin state", async () => {
    await expect(trpcEffectsPlugin.init(testPluginContext)).resolves.toBeUndefined()
  })

  it("dispatches classify() to the pure classifier", () => {
    const ctx = makeCtx({ imports: [makeTrpcClientImport()] })
    const result = trpcEffectsPlugin.classify(makeCall({ target: "client.user.byId.query" }), ctx)
    expect(result?.effectId).toBe("network.rpc")
  })

  it("returns null when the file is not a tRPC client consumer", () => {
    const ctx = makeCtx({ imports: [] })
    expect(
      trpcEffectsPlugin.classify(makeCall({ target: "client.user.byId.query" }), ctx),
    ).toBeNull()
  })

  it("class and singleton share behavior — the singleton is just a preconstructed instance", () => {
    const constructed = new TrpcEffectsPlugin()
    const ctx = makeCtx({ imports: [makeTrpcClientImport()] })
    const call = makeCall({ target: "client.user.create.mutate", argumentCount: 1 })
    expect(constructed.classify(call, ctx)).toEqual(trpcEffectsPlugin.classify(call, ctx))
  })

  it("classify is idempotent across repeated invocations (no per-call state)", () => {
    const ctx = makeCtx({ imports: [makeTrpcClientImport("@trpc/react-query")] })
    const call = makeCall({ target: "trpc.post.list.useQuery" })
    const runs = Array.from({ length: 5 }, () => trpcEffectsPlugin.classify(call, ctx))
    for (const run of runs) expect(run).toEqual(runs[0])
  })

  it("satisfies the EffectPlugin contract and declares no dropCallees", () => {
    // Widening to the interface both pins structural conformance and reaches the optional
    // `dropCallees` member, which the narrow class type does not carry. tRPC has no logger
    // surface that belongs in drop-list category C.
    const asEffectPlugin: EffectPlugin = trpcEffectsPlugin
    expect(asEffectPlugin.dropCallees).toBeUndefined()
  })
})
