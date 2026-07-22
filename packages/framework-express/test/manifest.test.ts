import { describe, expect, it } from "vitest"
import { EXPRESS_EXT_KINDS, frameworkExpressManifest } from "../src/index"

describe("frameworkExpressManifest", () => {
  it("declares the five Express extKinds", () => {
    const ids = frameworkExpressManifest.provides.extKinds.map((e) => e.id)
    expect(new Set(ids)).toEqual(new Set(EXPRESS_EXT_KINDS))
  })

  it("pins base kinds — router is const, everything else is call", () => {
    const byId = new Map(frameworkExpressManifest.provides.extKinds.map((e) => [e.id, e]))
    expect(byId.get("framework:express:router")?.baseKind).toBe("const")
    expect(byId.get("framework:express:route")?.baseKind).toBe("call")
    expect(byId.get("framework:express:middleware")?.baseKind).toBe("call")
    expect(byId.get("framework:express:error-middleware")?.baseKind).toBe("call")
    expect(byId.get("framework:express:mount")?.baseKind).toBe("call")
  })

  it("owns the framework:express prefix in both extKindPrefixes and derivedByPrefixes", () => {
    expect(frameworkExpressManifest.provides.extKindPrefixes).toContain("framework:express")
    expect(frameworkExpressManifest.provides.derivedByPrefixes).toContain("framework:express")
  })

  it("registers the express framework name and declares no effects", () => {
    expect(frameworkExpressManifest.provides.frameworks).toEqual(["express"])
    expect(frameworkExpressManifest.provides.effects).toHaveLength(0)
    expect(frameworkExpressManifest.provides.effectPrefixes).toHaveLength(0)
  })

  it("is typed as a framework plugin manifest", () => {
    expect(frameworkExpressManifest.type).toBe("framework")
  })
})
