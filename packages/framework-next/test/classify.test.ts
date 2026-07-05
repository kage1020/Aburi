import { describe, expect, it } from "vitest"
import { classifyNextSymbol } from "../src/index"
import { makeCandidate, makeCtx } from "./fixtures/symbol"

function makePageCandidate(file: string) {
  return makeCandidate({
    kind: "function",
    name: "Page",
    id: `ts:${file}#Page`,
    source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
    derivedBy: ["export-default"],
  })
}

describe("classifyNextSymbol — App Router pages / layouts / templates", () => {
  it.each([
    "page",
    "layout",
    "template",
    "loading",
    "error",
    "not-found",
  ])("classifies default export in app/**/%s.tsx as framework:next:%s", (role) => {
    const file = `app/dashboard/${role}.tsx`
    const result = classifyNextSymbol(
      makePageCandidate(file),
      makeCtx(file, "export default function Fn() { return null }"),
    )
    expect(result?.extKind).toBe(`framework:next:${role}`)
    expect(result?.derivedBy).toBe(`framework:next:${role}`)
  })

  it("returns null for non-default exports in a page file (helper functions)", () => {
    const file = "app/dashboard/page.tsx"
    const result = classifyNextSymbol(
      makeCandidate({
        kind: "function",
        name: "PageHelper",
        id: `ts:${file}#PageHelper`,
        source: { file, startLine: 5, endLine: 10, startColumn: null, endColumn: null },
      }),
      makeCtx(file, "export function PageHelper() {}"),
    )
    expect(result).toBeNull()
  })

  it("returns null for non-app-router files", () => {
    const file = "src/components/Widget.tsx"
    const result = classifyNextSymbol(
      makeCandidate({
        kind: "function",
        name: "Widget",
        id: `ts:${file}#Widget`,
        source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
        derivedBy: ["export-default"],
      }),
      makeCtx(file, "export default function Widget() {}"),
    )
    expect(result).toBeNull()
  })

  it("returns null for a default export whose kind is not function (e.g. constant)", () => {
    const file = "app/page.tsx"
    const result = classifyNextSymbol(
      makeCandidate({
        kind: "const",
        name: "value",
        id: `ts:${file}#value`,
        source: { file, startLine: 1, endLine: 3, startColumn: null, endColumn: null },
        derivedBy: ["export-default"],
      }),
      makeCtx(file, "export default 42"),
    )
    expect(result).toBeNull()
  })
})

describe("classifyNextSymbol — App Router route handlers", () => {
  it.each([
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "OPTIONS",
    "HEAD",
  ])("classifies named export %s in app/**/route.ts as framework:next:route", (verb) => {
    const file = "app/api/users/route.ts"
    const result = classifyNextSymbol(
      makeCandidate({
        kind: "function",
        name: verb,
        id: `ts:${file}#${verb}`,
        source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
      }),
      makeCtx(file, `export function ${verb}() {}`),
    )
    expect(result?.extKind).toBe("framework:next:route")
    expect(result?.derivedBy).toBe(`framework:next:route:${verb}`)
  })

  it("returns null for non-HTTP-verb named exports in a route file", () => {
    const file = "app/api/route.ts"
    const result = classifyNextSymbol(
      makeCandidate({
        kind: "function",
        name: "helper",
        id: `ts:${file}#helper`,
        source: { file, startLine: 5, endLine: 8, startColumn: null, endColumn: null },
      }),
      makeCtx(file, "export function helper() {}"),
    )
    expect(result).toBeNull()
  })

  it("returns null for the default export in a route file (verbs are named, not default)", () => {
    const file = "app/api/route.ts"
    const result = classifyNextSymbol(
      makePageCandidate(file),
      makeCtx(file, "export default function Handler() {}"),
    )
    expect(result).toBeNull()
  })

  it("propagates the lastQnameSegment throw for broken qnames instead of swallowing them", () => {
    // The core lastQnameSegment helper throws on empty / trailing-separator qnames.
    // This test locks the "do not swallow" contract at the framework-plugin seam so a
    // regression here shows up as a red test rather than a silent null.
    const file = "app/api/route.ts"
    expect(() =>
      classifyNextSymbol(
        makeCandidate({
          kind: "function",
          name: "foo::",
          id: `ts:${file}#foo::`,
          source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
        }),
        makeCtx(file, "export function foo::() {}"),
      ),
    ).toThrow()
  })
})

describe("classifyNextSymbol — 'use client' / 'use server' module directive", () => {
  it("appends framework:next:client-component to derivedBy when the file starts with 'use client'", () => {
    const file = "app/dashboard/page.tsx"
    const result = classifyNextSymbol(
      makePageCandidate(file),
      makeCtx(file, "'use client'\nexport default function Page() { return null }"),
    )
    expect(result?.extKind).toBe("framework:next:page")
    expect(result?.derivedBy).toBe("framework:next:page;framework:next:client-component")
  })

  it("appends framework:next:server-action to derivedBy when the file starts with 'use server'", () => {
    const file = "app/actions/route.ts"
    const result = classifyNextSymbol(
      makeCandidate({
        kind: "function",
        name: "POST",
        id: `ts:${file}#POST`,
        source: { file, startLine: 3, endLine: 5, startColumn: null, endColumn: null },
      }),
      makeCtx(file, "'use server'\nexport async function POST() {}"),
    )
    expect(result?.derivedBy).toBe("framework:next:route:POST;framework:next:server-action")
  })

  it("does not append a directive tag when the file has no top-of-module directive", () => {
    const file = "app/page.tsx"
    const result = classifyNextSymbol(
      makePageCandidate(file),
      makeCtx(file, "export default function Page() {}"),
    )
    expect(result?.derivedBy).toBe("framework:next:page")
  })
})
