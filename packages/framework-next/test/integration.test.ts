import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { classifyNextSymbol } from "../src/index"
import { makeCtx } from "./fixtures/symbol"

/** The extKind of each Symbol the TypeScript plugin extracts from `source`, by name. */
async function extKindsIn(path: string, source: string) {
  const { tree } = await langTypescriptPlugin.parseFile({ path, content: source })
  if (tree === null) throw new Error(`${path} did not parse`)
  const ctx = makeCtx(path, source)
  return Object.fromEntries(
    langTypescriptPlugin
      .extractSymbols(tree, ctx)
      .map((symbol) => [symbol.name, classifyNextSymbol(symbol, ctx)?.extKind ?? null]),
  )
}

describe("classifyNextSymbol over the Symbols the TypeScript plugin extracts", () => {
  it.each([
    ["page", "Page"],
    ["layout", "Layout"],
    ["template", "Template"],
    ["loading", "Loading"],
    ["error", "ErrorBoundary"],
    ["not-found", "NotFound"],
  ])("classifies the default export of app/**/%s.tsx, and not a helper beside it", async (role, name) => {
    const symbols = await extKindsIn(
      `app/dashboard/${role}.tsx`,
      [
        "export function formatDate(d: Date) { return d.toISOString() }",
        `export default function ${name}() { return null }`,
      ].join("\n"),
    )

    expect(symbols).toEqual({ formatDate: null, [name]: `framework:next:${role}` })
  })

  it("classifies a page whose default export is written apart from its declaration", async () => {
    const symbols = await extKindsIn(
      "app/dashboard/page.tsx",
      ["const Page = () => {", "  return null", "}", "export default Page"].join("\n"),
    )

    expect(symbols).toEqual({ Page: "framework:next:page" })
  })

  it("classifies each HTTP verb a route file exports", async () => {
    const symbols = await extKindsIn(
      "app/api/users/route.ts",
      [
        "export async function GET() { return new Response('ok') }",
        "export async function POST() { return new Response('created') }",
      ].join("\n"),
    )

    expect(symbols).toEqual({ GET: "framework:next:route", POST: "framework:next:route" })
  })
})
