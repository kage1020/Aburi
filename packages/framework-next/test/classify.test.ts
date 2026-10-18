import { describe, expect, it } from "vitest"
import { classifyNextSymbol } from "../src/index"
import { makeCtx, type SymbolShape, symbolIn } from "./fixtures/symbol"

const DEFAULT_EXPORT: SymbolShape = { derivedBy: ["export-default"] }

const KEYWORD_EXPORT: SymbolShape = { derivedBy: ["export-keyword"] }

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
    expect(classifyNextSymbol(symbolIn(file, "Fn", DEFAULT_EXPORT), makeCtx(file))).toEqual({
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
    expect(classifyNextSymbol(symbolIn(file, verb, KEYWORD_EXPORT), makeCtx(file))).toEqual({
      extKind: "framework:next:route",
      derivedBy: `framework:next:route:${verb}`,
    })
  })

  it.each<[string, string, SymbolShape, string[]]>([
    [
      "a const destructured from another value",
      "GET",
      { kind: "const", derivedBy: ["destructured-binding", "export-keyword"] },
      ["GET"],
    ],
    [
      "a const a call initialises",
      "GET",
      { kind: "const", derivedBy: ["call-argument-function", "export-keyword"] },
      ["GET"],
    ],
    ["a function an export clause names", "POST", { derivedBy: ["export-clause:POST"] }, ["POST"]],
    [
      "a const an export clause names under two verbs",
      "handler",
      { kind: "const", derivedBy: ["export-clause:GET", "export-clause:POST"] },
      ["GET", "POST"],
    ],
    [
      "a function exported by its keyword and by a clause under another verb",
      "GET",
      { derivedBy: ["export-keyword", "export-clause:HEAD"] },
      ["GET", "HEAD"],
    ],
  ])("makes %s a route for each verb the module exports it as", (_label, name, shape, verbs) => {
    const file = "app/api/users/route.ts"
    expect(classifyNextSymbol(symbolIn(file, name, shape), makeCtx(file))).toEqual({
      extKind: "framework:next:route",
      derivedBy: verbs.map((verb) => `framework:next:route:${verb}`).join(";"),
    })
  })

  it.each<[string, string, string, SymbolShape]>([
    ["a named export of a page", "app/dashboard/page.tsx", "PageHelper", KEYWORD_EXPORT],
    ["a default export outside app/", "src/components/Widget.tsx", "Widget", DEFAULT_EXPORT],
    [
      "a default export that is not a function",
      "app/page.tsx",
      "value",
      { kind: "const", derivedBy: ["export-default"] },
    ],
    [
      "a named export of a route that is no HTTP verb",
      "app/api/route.ts",
      "helper",
      KEYWORD_EXPORT,
    ],
    ["the default export of a route", "app/api/route.ts", "Handler", DEFAULT_EXPORT],
    [
      "a function of a route named after a verb it does not export",
      "app/api/route.ts",
      "OPTIONS",
      {},
    ],
    [
      "a const of a route named after a verb it does not export",
      "app/api/route.ts",
      "GET",
      { kind: "const" },
    ],
    ["a verb a route exports only as its default", "app/api/route.ts", "GET", DEFAULT_EXPORT],
    [
      "a verb a route's clause exports under another name",
      "app/api/route.ts",
      "GET",
      { derivedBy: ["export-clause:handler"] },
    ],
    [
      "a verb exported inside a namespace of a route",
      "app/api/route.ts",
      "Handlers.GET",
      KEYWORD_EXPORT,
    ],
    [
      "a class a route exports under a verb",
      "app/api/route.ts",
      "GET",
      { kind: "class", derivedBy: ["export-keyword"] },
    ],
    [
      "an exported verb const of a file that is no route",
      "app/api/auth/handlers.ts",
      "GET",
      { kind: "const", derivedBy: ["destructured-binding", "export-keyword"] },
    ],
  ])("returns null for %s", (_label, file, name, shape) => {
    expect(classifyNextSymbol(symbolIn(file, name, shape), makeCtx(file))).toBeNull()
  })
})

describe("classifyNextSymbol — the module's directive", () => {
  it.each([
    [
      "'use client'",
      "app/dashboard/page.tsx",
      "Page",
      DEFAULT_EXPORT,
      "framework:next:page;framework:next:client-component",
    ],
    [
      "'use server'",
      "app/actions/route.ts",
      "POST",
      KEYWORD_EXPORT,
      "framework:next:route:POST;framework:next:server-action",
    ],
  ])("appends what %s makes the module to derivedBy", (directive, file, name, shape, derivedBy) => {
    const ctx = makeCtx(file, `${directive}\nexport function ${name}() {}`)
    expect(classifyNextSymbol(symbolIn(file, name, shape), ctx)?.derivedBy).toBe(derivedBy)
  })

  it("appends nothing to a module with no directive", () => {
    const file = "app/page.tsx"
    const ctx = makeCtx(file, "export default function Page() {}")
    expect(classifyNextSymbol(symbolIn(file, "Page", DEFAULT_EXPORT), ctx)?.derivedBy).toBe(
      "framework:next:page",
    )
  })
})
