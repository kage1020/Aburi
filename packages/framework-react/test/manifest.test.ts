import { describe, expect, it } from "vitest"
import { frameworkReactManifest } from "../src/index"

describe("frameworkReactManifest", () => {
  it("declares the framework-react name and framework type", () => {
    expect(frameworkReactManifest.name).toBe("framework-react")
    expect(frameworkReactManifest.type).toBe("framework")
  })

  it("enumerates the seven React extKinds with baseKind fallback", () => {
    const ids = frameworkReactManifest.provides.extKinds.map((e) => e.id).sort()
    expect(ids).toEqual([
      "framework:react:component",
      "framework:react:context",
      "framework:react:forward-ref",
      "framework:react:hoc",
      "framework:react:hook",
      "framework:react:memo",
      "framework:react:provider",
    ])
    for (const entry of frameworkReactManifest.provides.extKinds) {
      expect(entry.description).not.toBe("")
      expect(["function", "const"]).toContain(entry.baseKind)
    }
  })

  it("keeps context/forward-ref/memo pinned to baseKind const, everything else to function", () => {
    const byId = new Map(frameworkReactManifest.provides.extKinds.map((e) => [e.id, e.baseKind]))
    expect(byId.get("framework:react:context")).toBe("const")
    expect(byId.get("framework:react:forward-ref")).toBe("const")
    expect(byId.get("framework:react:memo")).toBe("const")
    expect(byId.get("framework:react:component")).toBe("function")
    expect(byId.get("framework:react:hook")).toBe("function")
    expect(byId.get("framework:react:provider")).toBe("function")
    expect(byId.get("framework:react:hoc")).toBe("function")
  })

  it("owns the framework:react prefix in both extKind and derivedBy channels", () => {
    expect(frameworkReactManifest.provides.extKindPrefixes).toEqual(["framework:react"])
    expect(frameworkReactManifest.provides.derivedByPrefixes).toEqual(["framework:react"])
  })

  it("declares react as the framework name (matches core component autodetect)", () => {
    expect(frameworkReactManifest.provides.frameworks).toEqual(["react"])
  })

  it("declares no effect vocabulary (that is the effects plugin's job)", () => {
    expect(frameworkReactManifest.provides.effects).toEqual([])
    expect(frameworkReactManifest.provides.effectPrefixes).toEqual([])
  })
})
