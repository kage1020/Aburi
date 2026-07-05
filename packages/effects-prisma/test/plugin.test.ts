import type { PluginContext, VocabRegistry } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { PrismaEffectsPlugin, prismaEffectsPlugin } from "../src/index"
import { makeCall, makeCtx, makePrismaImport, noopRegistry } from "./fixtures/context"

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

describe("PrismaEffectsPlugin", () => {
  it("exposes the effects-prisma manifest", () => {
    expect(prismaEffectsPlugin.manifest.name).toBe("effects-prisma")
    expect(prismaEffectsPlugin.manifest.type).toBe("effects")
  })

  it("init resolves without touching plugin state", async () => {
    await expect(prismaEffectsPlugin.init(testPluginContext)).resolves.toBeUndefined()
  })

  it("dispatches classify() to the pure classifier", () => {
    const ctx = makeCtx({ imports: [makePrismaImport()] })
    const result = prismaEffectsPlugin.classify(makeCall({ target: "prisma.user.findMany" }), ctx)
    expect(result?.effectId).toBe("db.read")
  })

  it("returns null when the file is not a Prisma consumer", () => {
    const ctx = makeCtx({ imports: [] })
    expect(
      prismaEffectsPlugin.classify(makeCall({ target: "prisma.user.findMany" }), ctx),
    ).toBeNull()
  })

  it("class and singleton share behavior — the singleton is just a preconstructed instance", () => {
    const constructed = new PrismaEffectsPlugin()
    const ctx = makeCtx({ imports: [makePrismaImport()] })
    const call = makeCall({ target: "prisma.invoice.upsert" })
    expect(constructed.classify(call, ctx)).toEqual(prismaEffectsPlugin.classify(call, ctx))
  })

  it("classify is idempotent across repeated invocations (no per-call state)", () => {
    const ctx = makeCtx({ imports: [makePrismaImport()] })
    const call = makeCall({ target: "prisma.$transaction" })
    const runs = Array.from({ length: 5 }, () => prismaEffectsPlugin.classify(call, ctx))
    for (const r of runs) expect(r).toEqual(runs[0])
  })
})
