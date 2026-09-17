import { makeCall, makeCtx, noopRegistry, silentLogger } from "@aburi/test-support"
import type { PluginContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DrizzleEffectsPlugin, drizzleEffectsPlugin, effectsDrizzleManifest } from "../src/index"
import { makeDrizzleImport } from "./fixtures/context"

const testPluginContext: PluginContext = {
  registry: noopRegistry,
  config: {},
  workspaceRoot: "/tmp",
  log: silentLogger,
}

describe("DrizzleEffectsPlugin", () => {
  it("exposes the effects-drizzle manifest", () => {
    expect(drizzleEffectsPlugin.manifest).toBe(effectsDrizzleManifest)
  })

  it("init resolves without touching plugin state", async () => {
    await expect(drizzleEffectsPlugin.init(testPluginContext)).resolves.toBeUndefined()
  })

  it("dispatches classify() to the pure classifier, from the class and the singleton alike", () => {
    const ctx = makeCtx({ imports: [makeDrizzleImport()] })
    const call = makeCall({ target: "db.insert", argumentCount: 1 })
    const result = drizzleEffectsPlugin.classify(call, ctx)
    expect(result?.effectId).toBe("db.write")
    expect(new DrizzleEffectsPlugin().classify(call, ctx)).toEqual(result)
  })

  it("returns null when the file is not a Drizzle consumer", () => {
    const ctx = makeCtx({ imports: [] })
    expect(drizzleEffectsPlugin.classify(makeCall({ target: "db.select" }), ctx)).toBeNull()
  })

  it("classify is idempotent across repeated invocations (no per-call state)", () => {
    const ctx = makeCtx({ imports: [makeDrizzleImport()] })
    const call = makeCall({ target: "db.transaction", argumentCount: 1 })
    const runs = Array.from({ length: 5 }, () => drizzleEffectsPlugin.classify(call, ctx))
    for (const run of runs) expect(run).toEqual(runs[0])
  })
})
