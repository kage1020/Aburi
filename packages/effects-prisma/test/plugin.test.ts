import { makeCall, makeCtx, noopRegistry, silentLogger } from "@aburi/test-support"
import type { PluginContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { effectsPrismaManifest, PrismaEffectsPlugin, prismaEffectsPlugin } from "../src/index"
import { makePrismaImport } from "./fixtures/context"

const testPluginContext: PluginContext = {
  registry: noopRegistry,
  config: {},
  workspaceRoot: "/tmp",
  log: silentLogger,
}

describe("PrismaEffectsPlugin", () => {
  it("exposes the effects-prisma manifest", () => {
    expect(prismaEffectsPlugin.manifest).toBe(effectsPrismaManifest)
  })

  it("init resolves without touching plugin state", async () => {
    await expect(prismaEffectsPlugin.init(testPluginContext)).resolves.toBeUndefined()
  })

  it("dispatches classify() to the pure classifier, from the class and the singleton alike", () => {
    const ctx = makeCtx({ imports: [makePrismaImport()] })
    const call = makeCall({ target: "prisma.invoice.upsert" })
    const result = prismaEffectsPlugin.classify(call, ctx)
    expect(result?.effectId).toBe("db.write")
    expect(new PrismaEffectsPlugin().classify(call, ctx)).toEqual(result)
  })

  it("returns null when the file is not a Prisma consumer", () => {
    const ctx = makeCtx({ imports: [] })
    expect(
      prismaEffectsPlugin.classify(makeCall({ target: "prisma.user.findMany" }), ctx),
    ).toBeNull()
  })
})
