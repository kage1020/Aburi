import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nextFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("app-router-scan")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], frameworks: [nextFrameworkPlugin] })

describe("scan — App Router special files", () => {
  it.each([
    ["page", "Page"],
    ["layout", "Layout"],
    ["template", "Template"],
    ["loading", "Loading"],
    ["error", "ErrorBoundary"],
    ["not-found", "NotFound"],
  ])("classifies the default export of app/**/%s.tsx, and not a helper beside it", async (role, name) => {
    const file = `app/dashboard/${role}.tsx`
    await workspace.writeSource(
      file,
      [
        "export function formatDate(d: Date) { return d.toISOString() }",
        `export default function ${name}() { return null }`,
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolById(result, `ts:${file}#${name}`).extKind).toBe(`framework:next:${role}`)
    expect(symbolById(result, `ts:${file}#formatDate`).extKind).toBeNull()
  })

  it.each([
    ["by `export default`", "export default Page"],
    ["by an export clause", "export { Page as default }"],
  ])("classifies a page whose default export is written apart from its declaration, %s", async (_label, exportLine) => {
    await workspace.writeSource(
      "app/dashboard/page.tsx",
      ["const Page = () => {", "  return null", "}", exportLine, ""].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolById(result, "ts:app/dashboard/page.tsx#Page").extKind).toBe("framework:next:page")
  })

  it.each<[string, string[], Record<string, string[]>]>([
    [
      "functions declared with the export keyword",
      [
        "export async function GET() { return new Response('ok') }",
        "export async function POST() { return new Response('created') }",
      ],
      { GET: ["GET"], POST: ["POST"] },
    ],
    [
      "an arrow assigned to an exported const",
      ["export const GET = async () => new Response('ok')"],
      { GET: ["GET"] },
    ],
    [
      "consts destructured from Auth.js's handlers",
      ['import { handlers } from "@/auth"', "export const { GET, POST } = handlers"],
      { GET: ["GET"], POST: ["POST"] },
    ],
    [
      "a const a wrapping call initialises",
      [
        'import { auth } from "@/auth"',
        "export const GET = auth(async (req) => Response.json(req.auth))",
      ],
      { GET: ["GET"] },
    ],
    [
      "a function an export clause names",
      ["async function POST() { return new Response('created') }", "export { POST }"],
      { POST: ["POST"] },
    ],
    [
      "one handler an export clause names under two verbs",
      [
        'import NextAuth from "next-auth"',
        "const handler = NextAuth({})",
        "export { handler as GET, handler as POST }",
      ],
      { handler: ["GET", "POST"] },
    ],
  ])("classifies %s as the routes the module exports", async (_label, lines, routes) => {
    await workspace.writeSource("app/api/users/route.ts", [...lines, ""].join("\n"))

    const result = await scanWorkspace()

    for (const [name, verbs] of Object.entries(routes)) {
      const handler = symbolById(result, `ts:app/api/users/route.ts#${name}`)
      expect(handler.extKind).toBe("framework:next:route")
      expect(
        handler.derivedBy.filter((token) => token.startsWith("framework:next:route:")),
      ).toEqual(verbs.map((verb) => `framework:next:route:${verb}`))
    }
  })

  it.each([
    [
      "a function of a route file named after a verb the module does not export",
      "app/api/hook/route.ts",
      [
        "function OPTIONS() { return new Response(null, { status: 204 }) }",
        "export async function GET() { return OPTIONS() }",
      ],
      "OPTIONS",
    ],
    [
      "an export of a route file that is no HTTP verb",
      "app/api/users/route.ts",
      [
        "export const dynamic = 'force-dynamic'",
        "export async function GET() { return new Response('ok') }",
      ],
      "dynamic",
    ],
    [
      "a verb-named const exported from a file that is no route",
      "app/api/auth/handlers.ts",
      ['import { handlers } from "@/auth"', "export const { GET, POST } = handlers"],
      "GET",
    ],
    [
      "a function a route file exports only through a type-only clause",
      "app/api/users/route.ts",
      ["async function handler() { return new Response('ok') }", "export type { handler as GET }"],
      "handler",
    ],
    [
      "a verb-named function a route file exports through CommonJS",
      "app/api/users/route.js",
      ["function GET() { return new Response('ok') }", "module.exports = { GET }"],
      "GET",
    ],
  ])("does not classify %s", async (_label, file, lines, name) => {
    await workspace.writeSource(file, [...lines, ""].join("\n"))

    const result = await scanWorkspace()

    expect(symbolById(result, `ts:${file}#${name}`).extKind).toBeNull()
  })

  it("finds no route in a route file that only re-exports its verbs", async () => {
    await workspace.writeSource("app/api/auth/route.ts", 'export { GET, POST } from "@/auth"\n')

    const { ir } = await scanWorkspace()

    expect(ir.symbols.filter((symbol) => symbol.extKind === "framework:next:route")).toEqual([])
  })

  it("tags a page in a 'use client' module with both its role and the directive", async () => {
    await workspace.writeSource(
      "app/interactive/page.tsx",
      ["'use client'", "", "export default function Interactive() { return null }", ""].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolById(result, "ts:app/interactive/page.tsx#Interactive").derivedBy).toEqual(
      expect.arrayContaining(["framework:next:page", "framework:next:client-component"]),
    )
  })
})
