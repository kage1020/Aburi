import { describe, expect, it } from "vitest"
import { frameworkNestjsManifest } from "../src/index"

describe("frameworkNestjsManifest", () => {
  it("declares the framework-nestjs name and framework type", () => {
    expect(frameworkNestjsManifest.name).toBe("framework-nestjs")
    expect(frameworkNestjsManifest.type).toBe("framework")
  })

  it("owns the framework:nestjs extKind prefix + individual entries for baseKind fallback", () => {
    // Prefix ownership keeps the manifest open to future decorator support without a
    // manifest bump; individual enumeration gives VocabRegistry.findExtKind() a baseKind
    // fallback so consumers that only understand core SymbolKind can still render the
    // Symbol as class / method.
    expect(frameworkNestjsManifest.provides.extKindPrefixes).toEqual(["framework:nestjs"])
    const ids = frameworkNestjsManifest.provides.extKinds.map((e) => e.id).sort()
    expect(ids).toEqual([
      "framework:nestjs:controller",
      "framework:nestjs:filter",
      "framework:nestjs:module",
      "framework:nestjs:provider",
      "framework:nestjs:route",
    ])
    const routeEntry = frameworkNestjsManifest.provides.extKinds.find(
      (e) => e.id === "framework:nestjs:route",
    )
    expect(routeEntry?.baseKind).toBe("method")
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
