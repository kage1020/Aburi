import type { PluginManifest } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { ConfigError, normalizeFrameworkHints } from "../src/index"
import { hint, withHints } from "./fixtures/configs"

/**
 * normalizeFrameworkHints always returns one entry per `frameworkHints[]`. Tests assert that
 * shape up front, then use `single` to extract and narrow the manifest without relying on
 * non-null assertions (the codebase forbids `!` and `@biome-ignore`-style escape hatches).
 */
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

  it("C7 derives an ad-hoc framework plugin with hint:-prefixed extKindPrefixes", () => {
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

  it("rejects extKind written under the reserved framework:hint:* namespace", () => {
    const config = withHints(
      hint("acme", {
        decorators: {
          AcmeController: { extKind: "framework:hint:acme:controller" },
        },
      }),
    )
    let caught: unknown
    try {
      normalizeFrameworkHints(config)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("reserved-namespace")
    expect((caught as ConfigError).value).toBe("framework:hint:acme:controller")
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
    expect(plugin.$schema).toBe("https://aburi.dev/schema/aburi.plugin.v1.json")
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(plugin.engines.aburi).toBe("*")
    expect(plugin.provides.effects).toEqual([])
    expect(plugin.provides.effectPrefixes).toEqual([])
    for (const prefix of plugin.provides.extKindPrefixes) {
      expect(prefix.startsWith("framework:")).toBe(true)
    }
  })
})
