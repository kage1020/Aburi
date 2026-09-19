import { describe, expect, it } from "vitest"
import { EFFECTS_NEST_DERIVED_BY_PREFIX, effectsNestManifest } from "../src/index"

describe("effectsNestManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
    // The core `event.publish` id is returned from classify() and MUST NOT appear in
    // provides.effects (extension-vocab.md); an effects plugin cannot own extKinds or
    // frameworks either.
    expect(effectsNestManifest).toEqual({
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
      name: "effects-nest",
      version: "0.0.0",
      type: "effects",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: ["effects-plugin:nest"],
        frameworks: [],
      },
    })
  })

  it("shares its derivedBy prefix with the classifier's tag builder", () => {
    expect(effectsNestManifest.provides.derivedByPrefixes).toEqual([EFFECTS_NEST_DERIVED_BY_PREFIX])
  })
})
