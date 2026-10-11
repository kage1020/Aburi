import { describe, expect, it } from "vitest"
import { frameworkNextManifest, NEXT_APP_ROUTER_ROLES, NEXT_ROUTE_HTTP_VERBS } from "../src/index"

describe("frameworkNextManifest", () => {
  it("declares the nextjs framework, owning the framework:next prefixes and no effects", () => {
    expect(frameworkNextManifest).toMatchObject({
      name: "framework-next",
      type: "framework",
      provides: {
        effects: [],
        effectPrefixes: [],
        extKindPrefixes: ["framework:next"],
        derivedByPrefixes: ["framework:next"],
        frameworks: ["nextjs"],
      },
    })
  })

  it("declares a function extKind for each App Router role", () => {
    const roles = [...NEXT_APP_ROUTER_ROLES.values()]
    expect(frameworkNextManifest.provides.extKinds.map((e) => [e.id, e.baseKind])).toEqual(
      roles.map((role) => [`framework:next:${role}`, "function"]),
    )
  })
})

describe("public vocabulary", () => {
  it("maps each App Router file base name to the role it plays", () => {
    expect([...NEXT_APP_ROUTER_ROLES]).toEqual([
      ["page", "page"],
      ["layout", "layout"],
      ["template", "template"],
      ["loading", "loading"],
      ["error", "error"],
      ["not-found", "not-found"],
      ["route", "route"],
    ])
  })

  it("lists the HTTP verbs a route file exports", () => {
    expect([...NEXT_ROUTE_HTTP_VERBS]).toEqual([
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "OPTIONS",
      "HEAD",
    ])
  })
})
