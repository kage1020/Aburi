import { CoreError } from "@aburi/core"
import { describe, expect, it } from "vitest"
import { classifyNextSymbol } from "../src/index"
import { makeCtx, type SymbolShape, symbolIn } from "./fixtures/symbol"

describe("classifyNextSymbol — App Router special files", () => {
  it.each([
    "page",
    "layout",
    "template",
    "loading",
    "error",
    "not-found",
  ])("gives the default export of app/**/%s.tsx the extKind its role names", (role) => {
    const file = `app/dashboard/${role}.tsx`
    expect(
      classifyNextSymbol(symbolIn(file, "Fn", { exportDefault: true }), makeCtx(file)),
    ).toEqual({
      extKind: `framework:next:${role}`,
      derivedBy: `framework:next:${role}`,
    })
  })

  it.each([
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "OPTIONS",
    "HEAD",
  ])("makes the named export %s of app/**/route.ts a route", (verb) => {
    const file = "app/api/users/route.ts"
    expect(classifyNextSymbol(symbolIn(file, verb), makeCtx(file))).toEqual({
      extKind: "framework:next:route",
      derivedBy: `framework:next:route:${verb}`,
    })
  })

  it.each<[string, string, string, SymbolShape]>([
    ["a named export of a page", "app/dashboard/page.tsx", "PageHelper", {}],
    [
      "a default export outside app/",
      "src/components/Widget.tsx",
      "Widget",
      { exportDefault: true },
    ],
    [
      "a default export that is not a function",
      "app/page.tsx",
      "value",
      { kind: "const", exportDefault: true },
    ],
    ["a named export of a route that is no HTTP verb", "app/api/route.ts", "helper", {}],
    ["the default export of a route", "app/api/route.ts", "Handler", { exportDefault: true }],
  ])("returns null for %s", (_label, file, name, shape) => {
    expect(classifyNextSymbol(symbolIn(file, name, shape), makeCtx(file))).toBeNull()
  })

  it("lets a broken qualified name throw rather than read no verb", () => {
    const file = "app/api/route.ts"
    expect(() => classifyNextSymbol(symbolIn(file, "foo::"), makeCtx(file))).toThrow(CoreError)
  })
})

describe("classifyNextSymbol — the module's directive", () => {
  it.each([
    [
      "'use client'",
      "app/dashboard/page.tsx",
      "Page",
      { exportDefault: true },
      "framework:next:page;framework:next:client-component",
    ],
    [
      "'use server'",
      "app/actions/route.ts",
      "POST",
      {},
      "framework:next:route:POST;framework:next:server-action",
    ],
  ])("appends what %s makes the module to derivedBy", (directive, file, name, shape, derivedBy) => {
    const ctx = makeCtx(file, `${directive}\nexport function ${name}() {}`)
    expect(classifyNextSymbol(symbolIn(file, name, shape), ctx)?.derivedBy).toBe(derivedBy)
  })

  it("appends nothing to a module with no directive", () => {
    const file = "app/page.tsx"
    const ctx = makeCtx(file, "export default function Page() {}")
    expect(
      classifyNextSymbol(symbolIn(file, "Page", { exportDefault: true }), ctx)?.derivedBy,
    ).toBe("framework:next:page")
  })
})
