import { describe, expect, it } from "vitest"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, effectsPrismaManifest } from "../src/index"

describe("effectsPrismaManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
    // Core `db.*` ids are returned from classify() and MUST NOT appear in provides.effects
    // (extension-vocab.md); an effects plugin cannot own extKinds or frameworks either.
    expect(effectsPrismaManifest).toEqual({
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
      name: "effects-prisma",
      version: "0.0.0",
      type: "effects",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: ["effects-plugin:prisma"],
        frameworks: [],
      },
    })
  })

  it("shares its derivedBy prefix with the classifier's tag builder", () => {
    expect(effectsPrismaManifest.provides.derivedByPrefixes).toEqual([
      EFFECTS_PRISMA_DERIVED_BY_PREFIX,
    ])
  })
})
