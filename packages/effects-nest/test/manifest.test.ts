import { describe, expect, it } from "vitest"
import { effectsNestManifest } from "../src/index"

describe("effectsNestManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
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
})
