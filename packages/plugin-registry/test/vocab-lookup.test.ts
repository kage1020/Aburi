import { errorFrom } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { RegistryError, VocabRegistry } from "../src/index"
import { effectsManifest, frameworkManifest, langManifest } from "./fixtures/manifests"

const lang = langManifest({
  name: "lang-ts",
  provides: { extKinds: [{ id: "fp:lens", baseKind: "function", description: "a lens" }] },
})
const prisma = effectsManifest({
  name: "effects-prisma",
  provides: { effects: [{ id: "x-prisma:create", description: "prisma write" }] },
})
const acmeEffects = effectsManifest({
  name: "effects-acme",
  provides: { effectPrefixes: ["x-acme"] },
})
const nest = frameworkManifest({
  name: "framework-nest",
  provides: { frameworks: ["nestjs"], derivedByPrefixes: ["framework:nestjs"] },
})
const acmeFramework = frameworkManifest({
  name: "framework-acme",
  provides: { extKindPrefixes: ["framework:acme"] },
})

function registry(): VocabRegistry {
  const reg = new VocabRegistry()
  for (const manifest of [lang, prisma, acmeEffects, nest, acmeFramework]) reg.register(manifest)
  return reg
}

describe("VocabRegistry lookups", () => {
  it("answers a declared id with its entry and a prefix-owned one with nulls in its place", () => {
    const reg = registry()
    expect(reg.findEffect("x-prisma:create")).toEqual({
      id: "x-prisma:create",
      description: "prisma write",
      owner: prisma,
    })
    expect(reg.findEffect("x-acme:anything")).toEqual({
      id: "x-acme:anything",
      description: null,
      owner: acmeEffects,
    })
    expect(reg.findExtKind("fp:lens")).toEqual({
      id: "fp:lens",
      baseKind: "function",
      description: "a lens",
      owner: lang,
    })
    expect(reg.findExtKind("framework:acme:saga")).toEqual({
      id: "framework:acme:saga",
      baseKind: null,
      description: null,
      owner: acmeFramework,
    })
  })

  it("answers a framework by name and a derivedBy value by the prefix that owns it", () => {
    const reg = registry()
    expect(reg.findFramework("nestjs")).toEqual({ name: "nestjs", owner: nest })
    expect(reg.findDerivedByOwner("framework:nestjs:controller")).toBe(nest)
  })

  it.each([
    ["findEffect", (reg: VocabRegistry) => reg.findEffect("x-nobody:anything")],
    ["findExtKind", (reg: VocabRegistry) => reg.findExtKind("framework:nope:foo")],
    ["findFramework", (reg: VocabRegistry) => reg.findFramework("express")],
    ["findDerivedByOwner", (reg: VocabRegistry) => reg.findDerivedByOwner("framework:other:x")],
  ])("%s answers null for what nobody declared", (_, lookup) => {
    expect(lookup(registry())).toBeNull()
  })

  it("lists every registered entry, in registration order", () => {
    const reg = registry()
    expect(reg.listPlugins()).toEqual([lang, prisma, acmeEffects, nest, acmeFramework])
    expect(reg.listEffects().map((e) => e.id)).toEqual(["x-prisma:create"])
    expect(reg.listExtKinds().map((e) => e.id)).toEqual(["fp:lens"])
    expect(reg.listFrameworks().map((f) => f.name)).toEqual(["nestjs"])
  })
})

describe("VocabRegistry ownership", () => {
  it.each([
    ["isEffectOwnedBy", "x-prisma:create", "effects-prisma", true],
    ["isEffectOwnedBy", "x-acme:custom", "effects-acme", true],
    ["isEffectOwnedBy", "x-acme:custom", "effects-prisma", false],
    ["isEffectOwnedBy", "x-unknown:thing", "effects-acme", false],
    ["isExtKindOwnedBy", "fp:lens", "lang-ts", true],
    ["isExtKindOwnedBy", "framework:acme:job", "framework-acme", true],
    ["isExtKindOwnedBy", "framework:acme:job", "framework-nest", false],
    ["isExtKindOwnedBy", "framework:unknown:thing", "framework-acme", false],
  ] as const)("%s(%s, %s) is %s", (method, id, plugin, owned) => {
    expect(registry()[method](id, plugin)).toBe(owned)
  })

  it.each([
    ["assertEffectDeclared", "x-prisma:create", "effects-prisma"],
    ["assertEffectDeclared", "x-acme:custom", "effects-acme"],
    ["assertExtKindDeclared", "fp:lens", "lang-ts"],
    ["assertExtKindDeclared", "framework:acme:job", "framework-acme"],
  ] as const)("%s passes %s for its owner %s", (method, id, plugin) => {
    expect(() => registry()[method](id, plugin)).not.toThrow()
  })

  it.each([
    [
      "assertEffectDeclared",
      "x-nope:anything",
      "effects-acme",
      ["effects-acme"],
      'Effect id "x-nope:anything" is not declared by any registered plugin.',
    ],
    [
      "assertEffectDeclared",
      "x-prisma:create",
      "effects-impostor",
      ["effects-impostor", "effects-prisma"],
      'Effect id "x-prisma:create" is owned by plugin "effects-prisma", not "effects-impostor".',
    ],
    [
      "assertExtKindDeclared",
      "framework:nope:foo",
      "framework-x",
      ["framework-x"],
      'extKind id "framework:nope:foo" is not declared by any registered plugin.',
    ],
    [
      "assertExtKindDeclared",
      "framework:acme:job",
      "framework-impostor",
      ["framework-impostor", "framework-acme"],
      'extKind id "framework:acme:job" is owned by plugin "framework-acme", not ' +
        '"framework-impostor".',
    ],
  ] as const)("%s refuses %s for %s", async (method, id, plugin, plugins, message) => {
    const reg = registry()
    const err = await errorFrom(RegistryError, () => reg[method](id, plugin))
    expect(err).toMatchObject({ code: "vocab-undeclared", value: id, plugins })
    expect(err.message).toBe(message)
  })
})
