import type { PluginContext, VocabRegistry } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DrizzleEffectsPlugin, drizzleEffectsPlugin } from "../src/index"
import { makeCall, makeCtx, makeDrizzleImport, noopRegistry } from "./fixtures/context"

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

describe("DrizzleEffectsPlugin", () => {
  it("exposes the effects-drizzle manifest", () => {
    expect(drizzleEffectsPlugin.manifest.name).toBe("effects-drizzle")
    expect(drizzleEffectsPlugin.manifest.type).toBe("effects")
  })

  it("init resolves without touching plugin state", async () => {
    await expect(drizzleEffectsPlugin.init(testPluginContext)).resolves.toBeUndefined()
  })

  it("dispatches classify() to the pure classifier", () => {
    const ctx = makeCtx({ imports: [makeDrizzleImport()] })
    const result = drizzleEffectsPlugin.classify(makeCall({ target: "db.select" }), ctx)
    expect(result?.effectId).toBe("db.read")
  })

  it("returns null when the file is not a Drizzle consumer", () => {
    const ctx = makeCtx({ imports: [] })
    expect(drizzleEffectsPlugin.classify(makeCall({ target: "db.select" }), ctx)).toBeNull()
  })

  it("class and singleton share behavior — the singleton is just a preconstructed instance", () => {
    const constructed = new DrizzleEffectsPlugin()
    const ctx = makeCtx({ imports: [makeDrizzleImport()] })
    const call = makeCall({ target: "db.insert", argumentCount: 1 })
    expect(constructed.classify(call, ctx)).toEqual(drizzleEffectsPlugin.classify(call, ctx))
  })

  it("classify is idempotent across repeated invocations (no per-call state)", () => {
    const ctx = makeCtx({ imports: [makeDrizzleImport()] })
    const call = makeCall({ target: "db.transaction", argumentCount: 1 })
    const runs = Array.from({ length: 5 }, () => drizzleEffectsPlugin.classify(call, ctx))
    for (const r of runs) expect(r).toEqual(runs[0])
  })
})
