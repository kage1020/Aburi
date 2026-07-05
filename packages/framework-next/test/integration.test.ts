import {
  extractSymbols as extractTypescriptSymbols,
  parseTypescriptFile,
} from "@aburi/lang-typescript"
import type { ExtractionContext, SourceFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyNextSymbol } from "../src/index"

/**
 * End-to-end: parse a TypeScript source with `@aburi/lang-typescript`, run
 * `classifyNextSymbol` on every SymbolCandidate the language plugin emits, and confirm
 * that the framework plugin correctly assigns extKinds. Locks the wire between decorator
 * / name-based extraction in the language plugin and framework classification here.
 */

async function classifyEach(path: string, source: string) {
  const parseResult = await parseTypescriptFile({ path, content: source })
  const tree = parseResult.tree
  if (tree === null) throw new Error("parse returned null")
  const file: SourceFile = { path, content: source }
  const ctx: ExtractionContext = {
    file,
    registry: {
      findEffect: () => null,
      findExtKind: () => null,
      findFramework: () => null,
      findDerivedByOwner: () => null,
      isEffectOwnedBy: () => false,
      isExtKindOwnedBy: () => false,
      listEffects: () => [],
      listExtKinds: () => [],
      listFrameworks: () => [],
      listPlugins: () => [],
      assertEffectDeclared: () => {},
      assertExtKindDeclared: () => {},
    },
    config: {},
  }
  const candidates = extractTypescriptSymbols(tree, ctx)
  return candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    classification: classifyNextSymbol(candidate, ctx),
  }))
}

describe("integration — lang-typescript → framework-next", () => {
  it("classifies an app/**/page.tsx default export as framework:next:page", async () => {
    const results = await classifyEach(
      "app/dashboard/page.tsx",
      "export default function DashboardPage() {\n  return null\n}",
    )
    // Named-but-default exports keep their function name — the plugin identifies them via
    // the language plugin's `export-default` derivedBy marker rather than by name.
    const pageSymbol = results.find((r) => r.name === "DashboardPage")
    expect(pageSymbol?.classification?.extKind).toBe("framework:next:page")
  })

  it.each([
    ["page", "Page"],
    ["layout", "Layout"],
    ["template", "Template"],
    ["loading", "Loading"],
    ["error", "ErrorBoundary"],
    ["not-found", "NotFound"],
  ] as const)("classifies app/**/%s.tsx default export as framework:next:%s (table-driven)", async (role, componentName) => {
    const results = await classifyEach(
      `app/dashboard/${role}.tsx`,
      `export default function ${componentName}() { return null }`,
    )
    const found = results.find((r) => r.name === componentName)
    expect(found?.classification?.extKind).toBe(`framework:next:${role}`)
  })

  it("classifies an app/**/route.ts named GET / POST as framework:next:route", async () => {
    const results = await classifyEach(
      "app/api/users/route.ts",
      "export async function GET() { return new Response('ok') }\nexport async function POST() { return new Response('created') }",
    )
    const get = results.find((r) => r.name === "GET")
    const post = results.find((r) => r.name === "POST")
    expect(get?.classification?.extKind).toBe("framework:next:route")
    expect(post?.classification?.extKind).toBe("framework:next:route")
    expect(get?.classification?.derivedBy).toBe("framework:next:route:GET")
  })

  it("adds framework:next:client-component to derivedBy when 'use client' is present", async () => {
    const results = await classifyEach(
      "app/interactive/page.tsx",
      "'use client'\n\nexport default function Interactive() {\n  return null\n}",
    )
    const page = results.find((r) => r.name === "Interactive")
    expect(page?.classification?.derivedBy).toBe(
      "framework:next:page;framework:next:client-component",
    )
  })

  it("adds framework:next:server-action to derivedBy when 'use server' is present", async () => {
    const results = await classifyEach(
      "app/api/action/route.ts",
      "'use server'\n\nexport async function POST() { return new Response('ok') }",
    )
    const handler = results.find((r) => r.name === "POST")
    expect(handler?.classification?.derivedBy).toBe(
      "framework:next:route:POST;framework:next:server-action",
    )
  })

  it("returns null for helpers colocated in an App Router file", async () => {
    const results = await classifyEach(
      "app/dashboard/page.tsx",
      "export function formatDate(d: Date) { return d.toISOString() }\nexport default function Page() { return null }",
    )
    const helper = results.find((r) => r.name === "formatDate")
    const page = results.find((r) => r.name === "Page")
    expect(helper?.classification).toBeNull()
    expect(page?.classification?.extKind).toBe("framework:next:page")
  })

  it("returns null for components outside of app/", async () => {
    const results = await classifyEach(
      "src/components/Widget.tsx",
      "export default function Widget() { return null }",
    )
    const widget = results.find((r) => r.name === "Widget")
    expect(widget?.classification).toBeNull()
  })
})
