import type {
  Decorator,
  FrameworkClassifyContext,
  FrameworkHint,
  FrameworkPlugin,
  PluginManifest,
  SymbolCandidate,
  SymbolKind,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { frameworkHintPlugins, normalizeFrameworkHints } from "../src/index"
import { hint, withHints } from "./fixtures/configs"
import { configErrorFrom } from "./fixtures/errors"

/** The one manifest `normalizeFrameworkHints` returns for a single hint, narrowed for the assertions. */
function single(plugins: PluginManifest[]): PluginManifest {
  expect(plugins).toHaveLength(1)
  const [plugin] = plugins
  if (plugin === undefined) throw new Error("unreachable: length asserted above")
  return plugin
}

describe("normalizeFrameworkHints", () => {
  it("returns an empty array when no hints are declared", () => {
    expect(normalizeFrameworkHints({})).toEqual([])
  })

  it("derives an ad-hoc framework plugin with hint:-prefixed extKindPrefixes", () => {
    const plugin = single(
      normalizeFrameworkHints(
        withHints(
          hint("acme", {
            decorators: {
              AcmeController: { boundary: true, extKind: "framework:acme:controller" },
            },
          }),
        ),
      ),
    )
    expect(plugin.name).toBe("hint-acme")
    expect(plugin.type).toBe("framework")
    expect(plugin.provides.frameworks).toEqual(["acme"])
    expect(plugin.provides.extKindPrefixes).toEqual(["framework:hint:acme"])
    expect(plugin.provides.extKinds).toEqual([])
    expect(plugin.provides.effects).toEqual([])
    expect(plugin.provides.effectPrefixes).toEqual([])
  })

  it("rejects extKind written under the reserved framework:hint:* namespace", async () => {
    const config = withHints(
      hint("acme", {
        decorators: {
          AcmeController: { extKind: "framework:hint:acme:controller" },
        },
      }),
    )
    const caught = await configErrorFrom(() => normalizeFrameworkHints(config))
    expect(caught.code).toBe("reserved-namespace")
    expect(caught.value).toBe("framework:hint:acme:controller")
  })

  it("derives derivedByPrefixes from user-written framework-hint:* values without transforming them", () => {
    const plugin = single(
      normalizeFrameworkHints(
        withHints(
          hint("acme", {
            decorators: {
              AcmeController: {
                extKind: "framework:acme:controller",
                derivedBy: "framework-hint:acme:controller",
              },
            },
          }),
        ),
      ),
    )
    expect(plugin.provides.derivedByPrefixes).toEqual(["framework-hint:acme"])
  })

  it("merges decorators + classNamePatterns into the same synthesized plugin", () => {
    const plugin = single(
      normalizeFrameworkHints(
        withHints(
          hint("acme", {
            decorators: {
              AcmeController: { extKind: "framework:acme:controller" },
              AcmeService: { extKind: "framework:acme:service" },
            },
            classNamePatterns: {
              "*Handler": { extKind: "framework:acme:handler" },
            },
          }),
        ),
      ),
    )
    expect(plugin.provides.extKindPrefixes).toEqual(["framework:hint:acme"])
  })

  it("deduplicates derived prefixes across rules", () => {
    const plugin = single(
      normalizeFrameworkHints(
        withHints(
          hint("acme", {
            decorators: {
              A: { extKind: "framework:acme:controller", derivedBy: "framework-hint:acme:a" },
              B: { extKind: "framework:acme:service", derivedBy: "framework-hint:acme:b" },
            },
          }),
        ),
      ),
    )
    expect(plugin.provides.extKindPrefixes).toEqual(["framework:hint:acme"])
    expect(plugin.provides.derivedByPrefixes).toEqual(["framework-hint:acme"])
  })

  it("synthesizes one plugin per frameworkHints entry", () => {
    const config = withHints(
      hint("acme", { decorators: { A: { extKind: "framework:acme:a" } } }),
      hint("widgetco", { decorators: { B: { extKind: "framework:widgetco:b" } } }),
    )
    const plugins = normalizeFrameworkHints(config)
    expect(plugins.map((p) => p.name)).toEqual(["hint-acme", "hint-widgetco"])
  })

  it("produces a manifest that conforms to aburi.plugin.v1.json's framework-type allOf", () => {
    const plugin = single(
      normalizeFrameworkHints(
        withHints(hint("acme", { decorators: { A: { extKind: "framework:acme:controller" } } })),
      ),
    )
    expect(plugin.$schema).toBe("https://aburi.kage1020.com/schema/aburi.plugin.v1.json")
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(plugin.engines.aburi).toBe("*")
    expect(plugin.provides.effects).toEqual([])
    expect(plugin.provides.effectPrefixes).toEqual([])
    for (const prefix of plugin.provides.extKindPrefixes) {
      expect(prefix.startsWith("framework:")).toBe(true)
    }
  })
})

/** A Symbol as the framework stage hands it over, cut to what the hint rules read. */
function candidate(
  kind: SymbolKind,
  name: string,
  decorators: readonly (Pick<Decorator, "name"> & Partial<Decorator>)[] = [],
): SymbolCandidate {
  return {
    id: `ts:src/a.ts#${name}` as SymbolCandidate["id"],
    kind,
    extKind: null,
    name,
    visibility: "public",
    decorators: decorators.map((d) => ({
      raw: `${d.name}()`,
      arguments: [],
      boundary: false,
      line: 1,
      ...d,
    })),
    signature: null,
    source: { file: "src/a.ts", startLine: 1, endLine: 1, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: null,
    fullNode: {},
  }
}

const ctx = {
  file: { path: "src/a.ts", content: "" },
  registry: {} as FrameworkClassifyContext["registry"],
  config: {},
  imports: [],
} satisfies FrameworkClassifyContext

/** The one plugin `frameworkHintPlugins` builds for a single hint. */
function plugin(partial: Partial<FrameworkHint>): FrameworkPlugin {
  const plugins = frameworkHintPlugins(withHints(hint("acme", partial)))
  expect(plugins).toHaveLength(1)
  const [only] = plugins
  if (only === undefined) throw new Error("unreachable: length asserted above")
  return only
}

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
    const symbol = candidate("class", "UserController", [{ name: "AcmeController" }])
    expect(acme.classifySymbol(symbol, ctx)).toEqual({
      extKind: "framework:hint:acme:controller",
      decoratorBoundaries: { AcmeController: true },
      derivedBy: "framework-hint:acme:controller",
    })
  })

  it("matches a decorator on its leaf and files the boundary under the form it was written in", () => {
    const acme = plugin({ decorators: { AcmeController: { boundary: true } } })
    const symbol = candidate("class", "UserController", [
      { name: "AcmeController", qualifier: "acme" },
    ])
    expect(acme.classifySymbol(symbol, ctx)?.decoratorBoundaries).toEqual({
      "acme.AcmeController": true,
    })
  })

  it("applies a decorator rule to a method as well as a class", () => {
    const acme = plugin({ decorators: { AcmeRoute: { extKind: "framework:acme:route" } } })
    const symbol = candidate("method", "UserController.get", [{ name: "AcmeRoute" }])
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
    const result = acme.classifySymbol(candidate("class", name), ctx)
    expect(result?.extKind ?? null).toBe(matches ? "framework:hint:acme:x" : null)
  })

  it("matches class-name globs against classes only", () => {
    const acme = plugin({ classNamePatterns: { "*Handler": { extKind: "framework:acme:x" } } })
    expect(acme.classifySymbol(candidate("function", "orderHandler"), ctx)).toBeNull()
    expect(acme.classifySymbol(candidate("method", "OrderHandler.handle"), ctx)).toBeNull()
  })

  it("takes the first extKind, decorators before class names, and appends every derivedBy", () => {
    const acme = plugin({
      decorators: {
        AcmeJob: { extKind: "framework:acme:job", derivedBy: "acme:job" },
        AcmeController: { extKind: "framework:acme:controller", derivedBy: "acme:controller" },
      },
      classNamePatterns: { "*Handler": { extKind: "framework:acme:handler", derivedBy: "acme:h" } },
    })
    const symbol = candidate("class", "OrderHandler", [
      { name: "AcmeController" },
      { name: "AcmeJob" },
    ])
    expect(acme.classifySymbol(symbol, ctx)).toEqual({
      extKind: "framework:hint:acme:controller",
      derivedBy: "acme:controller;acme:job;acme:h",
    })
  })

  it("answers null when no rule applies, or the rules that apply only drop", () => {
    const acme = plugin({ decorators: { AcmeInternal: { drop: true } } })
    expect(acme.classifySymbol(candidate("class", "Plain"), ctx)).toBeNull()
    const internal = candidate("class", "Secret", [{ name: "AcmeInternal" }])
    expect(acme.classifySymbol(internal, ctx)).toBeNull()
  })

  it("drops a Symbol a drop rule applies to, naming the hint and the rule", () => {
    const acme = plugin({
      decorators: { AcmeInternal: { boundary: false, drop: true } },
      classNamePatterns: { "*Handler": { drop: true } },
    })
    const internal = candidate("class", "Secret", [{ name: "AcmeInternal" }])
    expect(acme.symbolDropHint?.(internal, ctx)).toEqual({
      reason: 'frameworkHints "acme": @AcmeInternal',
      category: "B",
    })
    expect(acme.symbolDropHint?.(candidate("class", "OrderHandler"), ctx)).toEqual({
      reason: 'frameworkHints "acme": class *Handler',
      category: "B",
    })
    expect(acme.symbolDropHint?.(candidate("class", "Order"), ctx)).toBeNull()
  })

  it("keeps a Symbol with a boundary decorator whatever its drop rules say", () => {
    const acme = plugin({ classNamePatterns: { "*Handler": { drop: true } } })
    const symbol = candidate("class", "OrderHandler", [{ name: "Controller", boundary: true }])
    expect(acme.symbolDropHint?.(symbol, ctx)).toBeNull()
  })
})
