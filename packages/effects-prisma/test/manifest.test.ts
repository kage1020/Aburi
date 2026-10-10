import { describe, expect, it } from "vitest"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, effectsPrismaManifest } from "../src/index"

describe("effectsPrismaManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
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
