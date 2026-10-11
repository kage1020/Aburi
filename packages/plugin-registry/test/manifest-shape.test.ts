import { errorFrom } from "@aburi/test-support"
import type { PluginManifest } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { RegistryError, VocabRegistry } from "../src/index"
import { effectsManifest, frameworkManifest, langManifest } from "./fixtures/manifests"

function refusal(manifest: unknown): Promise<RegistryError> {
  return errorFrom(RegistryError, () => new VocabRegistry().register(manifest as PluginManifest))
}

describe("a manifest whose shape register cannot read", () => {
  it.each([
    [5, "number"],
    [null, "null"],
  ])("refuses a name that is %s, naming no plugin", async (name, got) => {
    const err = await refusal({ ...effectsManifest(), name })
    expect(err).toMatchObject({ code: "manifest-invalid", plugins: [] })
    expect(err.message).toBe(`Plugin manifest name must be a string (got ${got}).`)
  })

  it("refuses a manifest without provides", async () => {
    const err = await refusal({ ...langManifest(), provides: undefined })
    expect(err).toMatchObject({ code: "manifest-invalid", plugins: ["lang-foo"] })
    expect(err.message).toBe('Plugin "lang-foo" is missing the required `provides` object.')
  })

  it.each([
    ["missing", undefined, "undefined"],
    ["null", null, "null"],
  ])("refuses a provides array that is %s", async (_, value, got) => {
    const m = langManifest({ name: "lang-demo" })
    const err = await refusal({ ...m, provides: { ...m.provides, frameworks: value } })
    expect(err).toMatchObject({ code: "manifest-invalid", plugins: ["lang-demo"] })
    expect(err.message).toBe(
      `Plugin "lang-demo" provides.frameworks must be an array (got ${got}).`,
    )
  })

  it("refuses a provides whose arrays are inherited rather than its own", async () => {
    const m = langManifest({ name: "lang-demo" })
    const err = await refusal({ ...m, provides: Object.create(m.provides) })
    expect(err).toMatchObject({ code: "manifest-invalid", plugins: ["lang-demo"] })
  })

  it.each([
    ["effects", "null", null],
    ["effects", "array", []],
    ["effects", "string", "x-prisma:read"],
    ["extKinds", "string", "framework:demo:thing"],
  ] as const)("refuses a provides.%s entry that is a %s", async (key, got, entry) => {
    const m = effectsManifest({ name: "effects-prisma" })
    const err = await refusal({ ...m, provides: { ...m.provides, [key]: [entry] } })
    expect(err.message).toBe(
      `Plugin "effects-prisma" provides.${key}[0] must be an object (got ${got}).`,
    )
  })

  it.each([
    ["effects", "description", { id: "x-prisma:create" }, "undefined"],
    [
      "effects",
      "id",
      Object.assign(Object.create({ id: "x-prisma:create" }), { description: "c" }),
      "undefined",
    ],
    ["extKinds", "id", { id: 1, baseKind: "class", description: "x" }, "number"],
    [
      "extKinds",
      "baseKind",
      { id: "framework:demo:thing", baseKind: 1, description: "x" },
      "number",
    ],
    [
      "extKinds",
      "description",
      { id: "framework:demo:thing", baseKind: "class", description: 1 },
      "number",
    ],
  ] as const)("refuses a provides.%s entry whose own %s is not a string", async (key, field, entry, got) => {
    const m = frameworkManifest({ name: "framework-demo" })
    const err = await refusal({ ...m, provides: { ...m.provides, [key]: [entry] } })
    expect(err.message).toBe(
      `Plugin "framework-demo" provides.${key}[0].${field} must be a string (got ${got}).`,
    )
  })

  it.each([
    "effectPrefixes",
    "extKindPrefixes",
    "frameworks",
    "derivedByPrefixes",
  ] as const)("refuses a provides.%s entry that is not a string", async (key) => {
    const m = langManifest({ name: "lang-demo" })
    const err = await refusal({ ...m, provides: { ...m.provides, [key]: [null] } })
    expect(err.message).toBe(`Plugin "lang-demo" provides.${key}[0] must be a string (got null).`)
  })

  it.each([
    "toString",
    "constructor",
    "__proto__",
  ])("refuses type %s rather than reading Object.prototype", async (type) => {
    const err = await refusal({ ...langManifest({ name: "lang-demo" }), type })
    expect(err).toMatchObject({ code: "manifest-invalid", plugins: ["lang-demo"] })
    expect(err.message).toBe(`Plugin "lang-demo" has unknown type "${type}"`)
  })
})
