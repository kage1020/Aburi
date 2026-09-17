import { describe, expect, it } from "vitest"
import { EFFECTS_DRIZZLE_DERIVED_BY_PREFIX, effectsDrizzleManifest } from "../src/index"

describe("effectsDrizzleManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
    // Core `db.*` ids are returned from classify() and MUST NOT appear in provides.effects
    // (extension-vocab.md); an effects plugin cannot own extKinds or frameworks either.
    expect(effectsDrizzleManifest).toEqual({
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
      name: "effects-drizzle",
      version: "0.0.0",
      type: "effects",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: ["effects-plugin:drizzle"],
        frameworks: [],
      },
    })
  })

  it("shares its derivedBy prefix with the classifier's tag builder", () => {
    expect(effectsDrizzleManifest.provides.derivedByPrefixes).toEqual([
      EFFECTS_DRIZZLE_DERIVED_BY_PREFIX,
    ])
  })
})
