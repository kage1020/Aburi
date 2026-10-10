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

  it("classifies a page whose default export is written apart from its declaration", async () => {
    await workspace.writeSource(
      "app/dashboard/page.tsx",
      ["const Page = () => {", "  return null", "}", "export default Page", ""].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolById(result, "ts:app/dashboard/page.tsx#Page").extKind).toBe("framework:next:page")
  })

  it("classifies each HTTP verb a route file exports, tagged with the verb", async () => {
    await workspace.writeSource(
      "app/api/users/route.ts",
      [
        "export async function GET() { return new Response('ok') }",
        "export async function POST() { return new Response('created') }",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    for (const verb of ["GET", "POST"]) {
      const handler = symbolById(result, `ts:app/api/users/route.ts#${verb}`)
      expect(handler.extKind).toBe("framework:next:route")
      expect(handler.derivedBy).toContain(`framework:next:route:${verb}`)
    }
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
