import { errorFrom } from "@aburi/test-support"
import type { PluginManifest } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { deriveXPrefix, RegistryError, VocabRegistry } from "../src/index"
import { effectsManifest, frameworkManifest, langManifest } from "./fixtures/manifests"

describe("the namespaces a plugin type may own", () => {
  it.each<[string, PluginManifest, string]>([
    [
      "a lang plugin declaring effects",
      langManifest({ provides: { effects: [{ id: "x-foo:read", description: "x" }] } }),
      'Plugin "lang-foo" (type lang) declares effects but only effects-type plugins may own x-* ' +
        "namespaces.",
    ],
    [
      "a framework plugin declaring an effect prefix",
      frameworkManifest({ provides: { effectPrefixes: ["x-foo"] } }),
      'Plugin "framework-foo" (type framework) declares effects but only effects-type plugins may ' +
        "own x-* namespaces.",
    ],
    [
      "a lang plugin declaring framework names",
      langManifest({ provides: { frameworks: ["nestjs"] } }),
      'Plugin "lang-foo" (type lang) declares frameworks but only framework-type plugins may own ' +
        "framework names.",
    ],
    [
      "an effects plugin declaring an extKind",
      effectsManifest({
        provides: { extKinds: [{ id: "framework:foo:bar", baseKind: "class", description: "x" }] },
      }),
      'Plugin "effects-foo" (type effects) declares extKind id "framework:foo:bar" but cannot own ' +
        "any extKind namespace.",
    ],
    [
      "a framework plugin declaring an extKind outside framework",
      frameworkManifest({
        provides: { extKinds: [{ id: "fp:match", baseKind: "function", description: "x" }] },
      }),
      'Plugin "framework-foo" (type framework) declares extKind id "fp:match" outside its allowed ' +
        "roots (framework).",
    ],
    [
      "a lang plugin declaring an extKind prefix outside fp, oop and meta",
      langManifest({ provides: { extKindPrefixes: ["framework:acme"] } }),
      'Plugin "lang-foo" (type lang) declares extKind prefix "framework:acme" outside its allowed ' +
        "roots (fp, oop, meta).",
    ],
  ])("refuses %s", async (_, manifest, message) => {
    const err = await errorFrom(RegistryError, () => new VocabRegistry().register(manifest))
    expect(err).toMatchObject({ code: "namespace-type-mismatch", plugins: [manifest.name] })
    expect(err.message).toBe(message)
  })
})

describe("an effects plugin's xPrefix", () => {
  it.each<[string, PluginManifest, string, string]>([
    [
      "an effect id outside x-<xPrefix>",
      effectsManifest({
        name: "effects-stripe",
        xPrefix: "stripe",
        provides: { effects: [{ id: "x-acme:charge", description: "x" }] },
      }),
      "x-acme:charge",
      'Plugin "effects-stripe" declares effect id "x-acme:charge" but xPrefix "stripe" requires ' +
        'the form "x-stripe:<action>".',
    ],
    [
      "an effect prefix other than x-<xPrefix>",
      effectsManifest({
        name: "effects-stripe",
        xPrefix: "stripe",
        provides: { effectPrefixes: ["x-acme"] },
      }),
      "x-acme",
      'Plugin "effects-stripe" declares effectPrefix "x-acme" but xPrefix "stripe" requires ' +
        '"x-stripe" exactly.',
    ],
    [
      "an effect id outside the xPrefix derived from a name without effects-",
      effectsManifest({
        name: "acme-effects",
        provides: { effects: [{ id: "x-acme:charge", description: "x" }] },
      }),
      "x-acme:charge",
      'Plugin "acme-effects" declares effect id "x-acme:charge" but xPrefix "acme-effects" ' +
        'requires the form "x-acme-effects:<action>".',
    ],
  ])("refuses %s", async (_, manifest, value, message) => {
    const err = await errorFrom(RegistryError, () => new VocabRegistry().register(manifest))
    expect(err).toMatchObject({ code: "xprefix-mismatch", value, plugins: [manifest.name] })
    expect(err.message).toBe(message)
  })

  it("derives the xPrefix from the name when the manifest declares none", () => {
    const reg = new VocabRegistry()
    reg.register(
      effectsManifest({
        name: "effects-prisma",
        provides: { effects: [{ id: "x-prisma:create", description: "x" }] },
      }),
    )
    expect(reg.findEffect("x-prisma:create")?.owner.name).toBe("effects-prisma")
  })

  it.each([
    ["effects-prisma", "prisma"],
    ["acme-effects", "acme-effects"],
  ])("deriveXPrefix reads %s as %s", (name, xPrefix) => {
    expect(deriveXPrefix(name)).toBe(xPrefix)
  })
})

describe("one manifest declaring an id twice", () => {
  it.each<[string, PluginManifest, string, string]>([
    [
      "an effect id with different descriptions",
      effectsManifest({
        name: "effects-demo",
        provides: {
          // Not adjacent, so a check against the previous entry alone would miss it.
          effects: [
            { id: "x-demo:read", description: "reads a row" },
            { id: "x-demo:write", description: "writes a row" },
            { id: "x-demo:read", description: "something else" },
          ],
        },
      }),
      "x-demo:read",
      'Effect id "x-demo:read" is declared twice by plugin "effects-demo".',
    ],
    [
      "an extKind id with different entries",
      langManifest({
        name: "lang-demo",
        provides: {
          extKinds: [
            { id: "fp:pipe", baseKind: "function", description: "a" },
            { id: "fp:pipe", baseKind: "class", description: "b" },
          ],
        },
      }),
      "fp:pipe",
      'extKind id "fp:pipe" is declared twice by plugin "lang-demo".',
    ],
    [
      "the same extKind entry",
      langManifest({
        name: "lang-demo",
        provides: {
          extKinds: [
            { id: "fp:pipe", baseKind: "function", description: "a" },
            { id: "fp:pipe", baseKind: "function", description: "a" },
          ],
        },
      }),
      "fp:pipe",
      'extKind id "fp:pipe" is declared twice by plugin "lang-demo".',
    ],
  ])("refuses %s, registering nothing", async (_, manifest, value, message) => {
    const reg = new VocabRegistry()
    const err = await errorFrom(RegistryError, () => reg.register(manifest))
    expect(err).toMatchObject({ code: "duplicate-id", value, plugins: [manifest.name] })
    expect(err.message).toBe(message)
    expect([reg.listPlugins(), reg.listEffects(), reg.listExtKinds()]).toEqual([[], [], []])
  })
})

describe("one manifest declaring prefixes that nest", () => {
  it.each([
    ["the shorter first", ["fp:pipe", "fp:pipe:async"], "fp:pipe:async", "fp:pipe"],
    ["the longer first", ["fp:pipe:async", "fp:pipe"], "fp:pipe", "fp:pipe:async"],
  ])("refuses extKind prefixes that nest, %s", async (_, [first, second], later, earlier) => {
    // Not adjacent, so a check against the previous entry alone would miss it.
    const m = langManifest({
      name: "lang-demo",
      provides: { extKindPrefixes: [first as string, "fp:map", second as string] },
    })
    const reg = new VocabRegistry()
    const err = await errorFrom(RegistryError, () => reg.register(m))
    expect(err).toMatchObject({
      code: "prefix-prefix-overlap",
      value: later,
      plugins: ["lang-demo"],
    })
    expect(err.message).toBe(
      `extKind prefix "${later}" overlaps with prefix "${earlier}", both declared by plugin ` +
        `"lang-demo".`,
    )
    expect(reg.listPlugins()).toEqual([])
  })

  it("refuses derivedBy prefixes that nest", async () => {
    const m = langManifest({
      name: "lang-demo",
      provides: { derivedByPrefixes: ["acme", "acme:route"] },
    })
    const reg = new VocabRegistry()
    const err = await errorFrom(RegistryError, () => reg.register(m))
    expect(err).toMatchObject({
      code: "derivedby-prefix-overlap",
      value: "acme:route",
      plugins: ["lang-demo"],
    })
    expect(err.message).toBe(
      'derivedBy prefix "acme:route" overlaps with prefix "acme", both declared by plugin ' +
        '"lang-demo".',
    )
    expect(reg.listPlugins()).toEqual([])
  })

  it("compares each list with itself, not the extKind and derivedBy lists with each other", () => {
    const reg = new VocabRegistry()
    reg.register(
      frameworkManifest({
        name: "framework-acme",
        provides: {
          extKindPrefixes: ["framework:acme", "framework:beta:jobs"],
          derivedByPrefixes: ["framework:acme", "framework:beta"],
        },
      }),
    )
    expect(reg.findExtKind("framework:acme:job")?.owner.name).toBe("framework-acme")
    expect(reg.findExtKind("framework:beta:jobs:nightly")?.owner.name).toBe("framework-acme")
    expect(reg.findDerivedByOwner("framework:acme:route")?.name).toBe("framework-acme")
    expect(reg.findDerivedByOwner("framework:beta:route")?.name).toBe("framework-acme")
  })

  it("accepts an extKind id under the same manifest's own extKind prefix", () => {
    const reg = new VocabRegistry()
    reg.register(
      frameworkManifest({
        name: "framework-acme",
        provides: {
          extKinds: [{ id: "framework:acme:module", baseKind: "class", description: "x" }],
          extKindPrefixes: ["framework:acme"],
        },
      }),
    )
    expect(reg.findExtKind("framework:acme:module")?.baseKind).toBe("class")
    expect(reg.findExtKind("framework:acme:other")?.baseKind).toBeNull()
  })

  it("accepts prefixes that only share a leading string, or are written twice", () => {
    const reg = new VocabRegistry()
    reg.register(
      langManifest({
        name: "lang-demo",
        provides: {
          extKindPrefixes: ["fp:pipe", "fp:pipeline", "fp:pipe"],
          derivedByPrefixes: ["acme", "acmegrid"],
        },
      }),
    )
    expect(reg.findExtKind("fp:pipe:x")?.owner.name).toBe("lang-demo")
    expect(reg.findExtKind("fp:pipeline:x")?.owner.name).toBe("lang-demo")
    expect(reg.findDerivedByOwner("acmegrid:x")?.name).toBe("lang-demo")
  })
})
