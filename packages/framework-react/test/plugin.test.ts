import { describe, expect, it } from "vitest"
import { frameworkReactManifest, ReactFrameworkPlugin, reactFrameworkPlugin } from "../src/index"
import { makeCandidate, makeCtx } from "./fixtures/symbol"

describe("ReactFrameworkPlugin — instance surface", () => {
  it("exposes the same manifest as the frameworkReactManifest constant", () => {
    expect(reactFrameworkPlugin.manifest).toBe(frameworkReactManifest)
    expect(new ReactFrameworkPlugin().manifest).toBe(frameworkReactManifest)
  })

  it("init resolves to undefined without touching global state", async () => {
    const plugin = new ReactFrameworkPlugin()
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

  it("classifySymbol dispatches through classifyReactSymbol for a hook naming match", () => {
    // Naming-only signal, no body required.
    const result = reactFrameworkPlugin.classifySymbol(
      makeCandidate({
        kind: "function",
        name: "useThing",
      }),
      makeCtx("src/f.tsx", "export function useThing() {}"),
    )
    expect(result?.extKind).toBe("framework:react:hook")
  })

  it("classifySymbol returns null for a Symbol whose kind is unrelated (interface)", () => {
    const result = reactFrameworkPlugin.classifySymbol(
      makeCandidate({ kind: "interface", name: "Props" }),
      makeCtx(),
    )
    expect(result).toBeNull()
  })

  it("is idempotent: repeated classifySymbol calls produce identical results", () => {
    const candidate = makeCandidate({ kind: "function", name: "useCounter" })
    const ctx = makeCtx("src/f.tsx", "export function useCounter() {}")
    const first = reactFrameworkPlugin.classifySymbol(candidate, ctx)
    const second = reactFrameworkPlugin.classifySymbol(candidate, ctx)
    expect(first).toEqual(second)
  })
})
