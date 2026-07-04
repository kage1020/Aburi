import { describe, expect, it } from "vitest"
import { frameworkNestjsManifest, NestjsFrameworkPlugin, nestjsFrameworkPlugin } from "../src/index"
import { makeCandidate, makeCtx, makeDecorator } from "./fixtures/symbol"

describe("NestjsFrameworkPlugin — instance surface", () => {
  it("exposes the same manifest as the frameworkNestjsManifest constant", () => {
    expect(nestjsFrameworkPlugin.manifest).toBe(frameworkNestjsManifest)
    expect(new NestjsFrameworkPlugin().manifest).toBe(frameworkNestjsManifest)
  })

  it("init resolves to undefined without touching global state", async () => {
    const plugin = new NestjsFrameworkPlugin()
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

  it("classifySymbol dispatches through classifyNestjsSymbol (class case)", () => {
    const result = nestjsFrameworkPlugin.classifySymbol(
      makeCandidate({
        kind: "class",
        name: "MyController",
        decorators: [makeDecorator("Controller", ["'/x'"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
  })

  it("classifySymbol dispatches through classifyNestjsSymbol (method case)", () => {
    const result = nestjsFrameworkPlugin.classifySymbol(
      makeCandidate({
        kind: "method",
        name: "MyController.handle",
        decorators: [makeDecorator("Post", ["'/x'"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
  })

  it("classifySymbol returns null for a kind the plugin does not recognize", () => {
    const result = nestjsFrameworkPlugin.classifySymbol(
      makeCandidate({
        kind: "function",
        name: "someFn",
        decorators: [makeDecorator("Controller")],
      }),
      makeCtx(),
    )
    expect(result).toBeNull()
  })

  it("is idempotent: repeated classifySymbol calls produce identical results", () => {
    const candidate = makeCandidate({
      kind: "class",
      name: "MyModule",
      decorators: [makeDecorator("Module", ["{}"])],
    })
    const first = nestjsFrameworkPlugin.classifySymbol(candidate, makeCtx())
    const second = nestjsFrameworkPlugin.classifySymbol(candidate, makeCtx())
    expect(first).toEqual(second)
  })
})
