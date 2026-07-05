import { describe, expect, it } from "vitest"
import { frameworkNextManifest, NEXT_APP_ROUTER_ROLES, NEXT_ROUTE_HTTP_VERBS } from "../src/index"

describe("frameworkNextManifest", () => {
  it("declares the framework-next name and framework type", () => {
    expect(frameworkNextManifest.name).toBe("framework-next")
    expect(frameworkNextManifest.type).toBe("framework")
  })

  it("enumerates the seven App Router extKinds with baseKind fallback", () => {
    const ids = frameworkNextManifest.provides.extKinds.map((e) => e.id).sort()
    expect(ids).toEqual([
      "framework:next:error",
      "framework:next:layout",
      "framework:next:loading",
      "framework:next:not-found",
      "framework:next:page",
      "framework:next:route",
      "framework:next:template",
    ])
    for (const entry of frameworkNextManifest.provides.extKinds) {
      expect(entry.baseKind).toBe("function")
      expect(entry.description).not.toBe("")
    }
  })

  it("owns the framework:next prefix in both extKind and derivedBy channels", () => {
    expect(frameworkNextManifest.provides.extKindPrefixes).toEqual(["framework:next"])
    expect(frameworkNextManifest.provides.derivedByPrefixes).toEqual(["framework:next"])
  })

  it("declares nextjs as the framework name (matches core component autodetect)", () => {
    expect(frameworkNextManifest.provides.frameworks).toEqual(["nextjs"])
  })

  it("declares no effect vocabulary (that is the effects plugin's job)", () => {
    expect(frameworkNextManifest.provides.effects).toEqual([])
    expect(frameworkNextManifest.provides.effectPrefixes).toEqual([])
  })
})

describe("public vocabulary exports", () => {
  it("exposes the App Router roles as a consumable Map", () => {
    expect(NEXT_APP_ROUTER_ROLES.get("page")).toBe("page")
    expect(NEXT_APP_ROUTER_ROLES.get("route")).toBe("route")
    expect(NEXT_APP_ROUTER_ROLES.get("component")).toBeUndefined()
  })

  it("exposes the recognized HTTP verbs so consumers can share the predicate", () => {
    for (const verb of ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"] as const) {
      expect(NEXT_ROUTE_HTTP_VERBS.has(verb)).toBe(true)
    }
    // Non-verbs are not in the literal union — the type-erased Set surface is used
    // deliberately here to lock the runtime behavior alongside the type shape.
    const untyped = NEXT_ROUTE_HTTP_VERBS as ReadonlySet<string>
    expect(untyped.has("CONNECT")).toBe(false)
    expect(untyped.has("TRACE")).toBe(false)
  })

  it("keeps the manifest extKind ids in sync with the App Router roles", () => {
    const manifestIds = new Set(
      frameworkNextManifest.provides.extKinds.map((e) => e.id.replace("framework:next:", "")),
    )
    for (const role of NEXT_APP_ROUTER_ROLES.values()) {
      expect(manifestIds.has(role)).toBe(true)
    }
  })
})
