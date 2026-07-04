import { describe, expect, it } from "vitest"
import { frameworkNestjsManifest } from "../src/index"

describe("frameworkNestjsManifest", () => {
  it("declares the framework-nestjs name and framework type", () => {
    expect(frameworkNestjsManifest.name).toBe("framework-nestjs")
    expect(frameworkNestjsManifest.type).toBe("framework")
  })

  it("owns only the framework:nestjs extKind prefix (no individual extKinds enumerated)", () => {
    expect(frameworkNestjsManifest.provides.extKinds).toEqual([])
    expect(frameworkNestjsManifest.provides.extKindPrefixes).toEqual(["framework:nestjs"])
  })

  it("owns the framework:nestjs derivedBy prefix", () => {
    expect(frameworkNestjsManifest.provides.derivedByPrefixes).toEqual(["framework:nestjs"])
  })

  it("declares nestjs as the framework name", () => {
    expect(frameworkNestjsManifest.provides.frameworks).toEqual(["nestjs"])
  })

  it("declares no effect vocabulary — that is the effects plugin's job", () => {
    expect(frameworkNestjsManifest.provides.effects).toEqual([])
    expect(frameworkNestjsManifest.provides.effectPrefixes).toEqual([])
  })
})
