import { parsePluginManifest, VocabRegistry } from "@aburi/plugin-registry"
import { decorator, errorFrom, makeCandidate, makeExtractionCtx } from "@aburi/test-support"
import type { FrameworkClassifyContext, FrameworkHint, FrameworkPlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { ConfigError, frameworkHintPlugins, normalizeFrameworkHints } from "../src/index"
import { hint, withHints } from "./fixtures/configs"

/** The one plugin `frameworkHintPlugins` builds for a config holding the single hint `acme`. */
function plugin(partial: Partial<FrameworkHint>): FrameworkPlugin {
  const plugins = frameworkHintPlugins(withHints(hint("acme", partial)))
  expect(plugins).toHaveLength(1)
  const [only] = plugins
  if (only === undefined) throw new Error("unreachable: length asserted above")
  return only
}

describe("the manifest a frameworkHints entry synthesizes", () => {
  it("returns an empty array when no hints are declared", () => {
    expect(normalizeFrameworkHints({})).toEqual([])
  })

  it("synthesizes a framework manifest owning the hint-prefixed parents of every rule's values", () => {
    const { manifest } = plugin({
      decorators: {
        AcmeController: {
          boundary: true,
          extKind: "framework:acme:controller",
          derivedBy: "framework-hint:acme:controller",
        },
        AcmeService: {
          extKind: "framework:acme:service",
          derivedBy: "framework-hint:acme:service",
        },
      },
      classNamePatterns: { "*Handler": { extKind: "framework:acme:handler" } },
    })
    expect(manifest).toEqual({
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
      name: "hint-acme",
      version: "0.0.0",
      type: "framework",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: ["framework:hint:acme"],
        derivedByPrefixes: ["framework-hint:acme"],
        frameworks: ["acme"],
      },
    })
  })

  it("sorts the prefixes and keeps a single-segment derivedBy whole", () => {
    const { manifest } = plugin({
      decorators: {
        Z: { extKind: "framework:zeta:job", derivedBy: "zeta:job" },
        M: { derivedBy: "myhint" },
        A: { extKind: "framework:alpha:job", derivedBy: "alpha:job" },
      },
    })
    expect(manifest.provides.extKindPrefixes).toEqual([
      "framework:hint:alpha",
      "framework:hint:zeta",
    ])
    expect(manifest.provides.derivedByPrefixes).toEqual(["alpha", "myhint", "zeta"])
  })

  it("passes the plugin schema and registers as a hint", () => {
    const { manifest } = plugin({
      decorators: {
        A: { extKind: "framework:acme:controller", derivedBy: "framework-hint:acme:a" },
      },
    })
    expect(parsePluginManifest(JSON.stringify(manifest), "hint-acme")).toEqual(manifest)
    const registry = new VocabRegistry()
    registry.registerHint(manifest)
    expect(registry.findExtKind("framework:hint:acme:controller")?.owner).toBe(manifest)
  })

  it("rejects extKind written under the reserved framework:hint:* namespace", async () => {
    const config = withHints(
      hint("acme", {
        decorators: {
          AcmeController: { extKind: "framework:hint:acme:controller" },
        },
      }),
    )
    const caught = await errorFrom(ConfigError, () => normalizeFrameworkHints(config))
    expect(caught.code).toBe("reserved-namespace")
    expect(caught.value).toBe("framework:hint:acme:controller")
  })

  it("synthesizes one plugin per frameworkHints entry", () => {
    const config = withHints(
      hint("acme", { decorators: { A: { extKind: "framework:acme:a" } } }),
      hint("widgetco", { decorators: { B: { extKind: "framework:widgetco:b" } } }),
    )
    expect(normalizeFrameworkHints(config).map((p) => p.name)).toEqual([
      "hint-acme",
      "hint-widgetco",
    ])
  })
})

const ctx: FrameworkClassifyContext = { ...makeExtractionCtx(), imports: [] }

describe("frameworkHintPlugins", () => {
  it("carries the same manifest normalizeFrameworkHints returns", () => {
    const config = withHints(
      hint("acme", { decorators: { A: { extKind: "framework:acme:a", derivedBy: "acme:a" } } }),
    )
    expect(frameworkHintPlugins(config).map((p) => p.manifest)).toEqual(
      normalizeFrameworkHints(config),
    )
  })

  it("gives a Symbol carrying the decorator its hint-prefixed extKind, boundary and derivedBy", () => {
    const acme = plugin({
      decorators: {
        AcmeController: {
          boundary: true,
          extKind: "framework:acme:controller",
          derivedBy: "framework-hint:acme:controller",
        },
      },
    })
    const symbol = makeCandidate({
      kind: "class",
      name: "UserController",
      decorators: [decorator({ name: "AcmeController" })],
    })
    expect(acme.classifySymbol(symbol, ctx)).toEqual({
      extKind: "framework:hint:acme:controller",
      decoratorBoundaries: { AcmeController: true },
      derivedBy: "framework-hint:acme:controller",
    })
  })

  it("matches a decorator on its leaf and files the boundary under the form it was written in", () => {
    const acme = plugin({ decorators: { AcmeController: { boundary: true } } })
    const symbol = makeCandidate({
      kind: "class",
      name: "UserController",
      decorators: [decorator({ name: "AcmeController", qualifier: "acme" })],
    })
    expect(acme.classifySymbol(symbol, ctx)?.decoratorBoundaries).toEqual({
      "acme.AcmeController": true,
    })
  })

  it("applies a decorator rule to a method as well as a class", () => {
    const acme = plugin({ decorators: { AcmeRoute: { extKind: "framework:acme:route" } } })
    const symbol = makeCandidate({
      kind: "method",
      name: "UserController.get",
      decorators: [decorator({ name: "AcmeRoute" })],
    })
    expect(acme.classifySymbol(symbol, ctx)?.extKind).toBe("framework:hint:acme:route")
  })

  it.each([
    ["*Handler", "OrderHandler", true],
    ["*Handler", "Outer.OrderHandler", true],
    ["*Handler", "OrderHandlers", false],
    ["Abstract*", "AbstractRepo", true],
    ["Abstract*", "MyAbstractRepo", false],
    ["Repo?", "RepoA", true],
    ["Repo?", "Repo", false],
    ["A.B*", "AxBc", false],
  ])("matches class-name glob %j against %j: %s", (pattern, name, matches) => {
    const acme = plugin({ classNamePatterns: { [pattern]: { extKind: "framework:acme:x" } } })
    const result = acme.classifySymbol(makeCandidate({ kind: "class", name }), ctx)
    expect(result?.extKind ?? null).toBe(matches ? "framework:hint:acme:x" : null)
  })

  it("matches class-name globs against classes only", () => {
    const acme = plugin({ classNamePatterns: { "*Handler": { extKind: "framework:acme:x" } } })
    expect(
      acme.classifySymbol(makeCandidate({ kind: "function", name: "orderHandler" }), ctx),
    ).toBeNull()
    expect(
      acme.classifySymbol(makeCandidate({ kind: "method", name: "OrderHandler.handle" }), ctx),
    ).toBeNull()
  })

  it("takes the first extKind, decorators before class names, and appends every derivedBy", () => {
    const acme = plugin({
      decorators: {
        AcmeJob: { extKind: "framework:acme:job", derivedBy: "acme:job" },
        AcmeController: { extKind: "framework:acme:controller", derivedBy: "acme:controller" },
      },
      classNamePatterns: { "*Handler": { extKind: "framework:acme:handler", derivedBy: "acme:h" } },
    })
    const symbol = makeCandidate({
      kind: "class",
      name: "OrderHandler",
      decorators: [decorator({ name: "AcmeController" }), decorator({ name: "AcmeJob" })],
    })
    expect(acme.classifySymbol(symbol, ctx)).toEqual({
      extKind: "framework:hint:acme:controller",
      derivedBy: "acme:controller;acme:job;acme:h",
    })
  })

  it("answers null when no rule applies, or the rules that apply only drop", () => {
    const acme = plugin({ decorators: { AcmeInternal: { drop: true } } })
    expect(acme.classifySymbol(makeCandidate({ kind: "class", name: "Plain" }), ctx)).toBeNull()
    const internal = makeCandidate({
      kind: "class",
      name: "Secret",
      decorators: [decorator({ name: "AcmeInternal" })],
    })
    expect(acme.classifySymbol(internal, ctx)).toBeNull()
  })

  it("drops a Symbol a drop rule applies to, naming the hint and the rule", () => {
    const acme = plugin({
      decorators: { AcmeInternal: { boundary: false, drop: true } },
      classNamePatterns: { "*Handler": { drop: true } },
    })
    const internal = makeCandidate({
      kind: "class",
      name: "Secret",
      decorators: [decorator({ name: "AcmeInternal" })],
    })
    expect(acme.symbolDropHint?.(internal, ctx)).toEqual({
      reason: 'frameworkHints "acme": @AcmeInternal',
      category: "B",
    })
    expect(
      acme.symbolDropHint?.(makeCandidate({ kind: "class", name: "OrderHandler" }), ctx),
    ).toEqual({
      reason: 'frameworkHints "acme": class *Handler',
      category: "B",
    })
    expect(acme.symbolDropHint?.(makeCandidate({ kind: "class", name: "Order" }), ctx)).toBeNull()
  })

  it("keeps a Symbol with a boundary decorator whatever its drop rules say", () => {
    const acme = plugin({ classNamePatterns: { "*Handler": { drop: true } } })
    const symbol = makeCandidate({
      kind: "class",
      name: "OrderHandler",
      decorators: [decorator({ name: "Controller", boundary: true })],
    })
    expect(acme.symbolDropHint?.(symbol, ctx)).toBeNull()
  })
})
