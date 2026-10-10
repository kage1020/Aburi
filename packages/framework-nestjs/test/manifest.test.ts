import { describe, expect, it } from "vitest"
import { frameworkNestjsManifest } from "../src/index"

describe("frameworkNestjsManifest", () => {
  it("declares the nestjs framework, owning the framework:nestjs prefixes and no effects", () => {
    expect(frameworkNestjsManifest).toMatchObject({
      name: "framework-nestjs",
      type: "framework",
      provides: {
        effects: [],
        effectPrefixes: [],
        extKindPrefixes: ["framework:nestjs"],
        derivedByPrefixes: ["framework:nestjs"],
        frameworks: ["nestjs"],
      },
    })
  })

  it("declares each extKind with the base kind it falls back to", () => {
    expect(frameworkNestjsManifest.provides.extKinds.map((e) => [e.id, e.baseKind])).toEqual([
      ["framework:nestjs:module", "class"],
      ["framework:nestjs:controller", "class"],
      ["framework:nestjs:provider", "class"],
      ["framework:nestjs:filter", "class"],
      ["framework:nestjs:route", "method"],
    ])
  })
})
