import { errorFrom } from "@aburi/test-support"
import type { PluginManifest } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { RegistryError, VocabRegistry } from "../src/index"
import { effectsManifest, langManifest } from "./fixtures/manifests"

describe("registering one plugin name twice", () => {
  const prisma = () =>
    effectsManifest({
      name: "effects-prisma",
      provides: { effects: [{ id: "x-prisma:create", description: "create" }] },
    })

  it("is a no-op for the same contents, whatever object or key order carries them", () => {
    const reg = new VocabRegistry()
    const m = prisma()
    reg.register(m)
    reg.register(m)
    reg.register(structuredClone(m))
    reg.register({
      provides: {
        frameworks: [],
        derivedByPrefixes: [],
        extKindPrefixes: [],
        extKinds: [],
        effectPrefixes: [],
        effects: [{ description: "create", id: "x-prisma:create" }],
      },
      engines: { aburi: "^1.0.0" },
      type: "effects",
      version: "1.0.0",
      name: "effects-prisma",
      $schema: m.$schema,
    })
    expect(reg.listPlugins()).toEqual([m])
    expect(reg.listEffects()).toHaveLength(1)
  })

  it("refuses different contents as a name collision", async () => {
    const reg = new VocabRegistry()
    reg.register(prisma())
    const changed = prisma()
    changed.provides.effects.push({ id: "x-prisma:update", description: "update" })
    const err = await errorFrom(RegistryError, () => reg.register(changed))
    expect(err).toMatchObject({ code: "name-collision", plugins: ["effects-prisma"] })
    expect(err.message).toBe(
      'Plugin "effects-prisma" is already registered with a different manifest. ' +
        "Idempotent re-register requires identical contents.",
    )
  })

  it.each([
    ["a Date", new Date(0), "non-plain object (Date)"],
    ["a Map", new Map(), "non-plain object (Map)"],
    ["undefined", undefined, "non-JSON value (undefined)"],
    ["a function", () => 0, "non-JSON value (function)"],
  ])("refuses a manifest holding %s, whose contents could not be compared", async (_, held, what) => {
    const m = { ...langManifest(), capabilities: { wasmHeapPerWorkerMB: held } }
    const err = await errorFrom(RegistryError, () =>
      new VocabRegistry().register(m as unknown as PluginManifest),
    )
    expect(err.code).toBe("manifest-invalid")
    expect(err.message).toContain(`${what} at $.capabilities.wasmHeapPerWorkerMB`)
  })
})
