import { describe, expect, it } from "vitest"
import { effectsDrizzleManifest } from "../src/index"

describe("effectsDrizzleManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
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
})
