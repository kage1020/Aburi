import { describe, expect, it } from "vitest"
import { effectsPrismaManifest } from "../src/index"

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
})
