import { describe, expect, it } from "vitest"
import { frameworkNextManifest, NextFrameworkPlugin, nextFrameworkPlugin } from "../src/index"
import { makeCandidate, makeCtx } from "./fixtures/symbol"

describe("NextFrameworkPlugin — instance surface", () => {
  it("exposes the same manifest as the frameworkNextManifest constant", () => {
    expect(nextFrameworkPlugin.manifest).toBe(frameworkNextManifest)
    expect(new NextFrameworkPlugin().manifest).toBe(frameworkNextManifest)
  })

  it("init resolves to undefined without touching global state", async () => {
    const plugin = new NextFrameworkPlugin()
    await expect(
      plugin.init({
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
        workspaceRoot: "/tmp",
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      }),
    ).resolves.toBeUndefined()
  })

  it("classifySymbol dispatches through classifyNextSymbol for page.tsx default export", () => {
    const file = "app/dashboard/page.tsx"
    const result = nextFrameworkPlugin.classifySymbol(
      makeCandidate({
        kind: "function",
        name: "Page",
        id: `ts:${file}#Page`,
        source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
        derivedBy: ["export-default"],
      }),
      makeCtx(file, "export default function Page() {}"),
    )
    expect(result?.extKind).toBe("framework:next:page")
  })

  it("classifySymbol returns null for a non-app-router Symbol", () => {
    const file = "src/utils/helper.ts"
    const result = nextFrameworkPlugin.classifySymbol(
      makeCandidate({
        kind: "function",
        name: "helper",
        id: `ts:${file}#helper`,
        source: { file, startLine: 1, endLine: 3, startColumn: null, endColumn: null },
      }),
      makeCtx(file, "export function helper() {}"),
    )
    expect(result).toBeNull()
  })

  it("is idempotent: repeated classifySymbol calls produce identical results", () => {
    const file = "app/api/users/route.ts"
    const candidate = makeCandidate({
      kind: "function",
      name: "GET",
      id: `ts:${file}#GET`,
      source: { file, startLine: 1, endLine: 3, startColumn: null, endColumn: null },
    })
    const ctx = makeCtx(file, "export async function GET() {}")
    const first = nextFrameworkPlugin.classifySymbol(candidate, ctx)
    const second = nextFrameworkPlugin.classifySymbol(candidate, ctx)
    expect(first).toEqual(second)
  })
})
