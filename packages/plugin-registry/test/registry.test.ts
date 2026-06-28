import { describe, expect, it } from "vitest"
import { RegistryError, VocabRegistry } from "../src/index"
import { effectsManifest, frameworkManifest, langManifest } from "./fixtures/manifests"

function expectRegistryError(fn: () => void, code: string): RegistryError {
  try {
    fn()
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err
    expect(err.code).toBe(code)
    return err
  }
  throw new Error(`Expected RegistryError(code=${code}) but no throw occurred`)
}

describe("VocabRegistry.register (AC1 idempotent re-registration)", () => {
  it("re-registering the same plugin with identical contents is a no-op", () => {
    const reg = new VocabRegistry()
    const m = effectsManifest({
      name: "effects-prisma",
      xPrefix: "prisma",
    })
    m.provides.effects.push({ id: "x-prisma:create", description: "create" })
    reg.register(m)
    reg.register(m)
    // Same content, different reference -> still no-op.
    const cloned = JSON.parse(JSON.stringify(m))
    reg.register(cloned)
    expect(reg.listPlugins()).toHaveLength(1)
    expect(reg.listEffects()).toHaveLength(1)
  })

  it("re-registering the same plugin name with different contents throws name-collision", () => {
    const reg = new VocabRegistry()
    const a = effectsManifest({ name: "effects-prisma", xPrefix: "prisma" })
    a.provides.effects.push({ id: "x-prisma:create", description: "create" })
    reg.register(a)
    const b = effectsManifest({ name: "effects-prisma", xPrefix: "prisma" })
    b.provides.effects.push({ id: "x-prisma:update", description: "update" })
    expectRegistryError(() => reg.register(b), "name-collision")
  })
})

describe("VocabRegistry.register (AC2 reserved namespace)", () => {
  it("rejects extKind under reserved core:* namespace (V4)", () => {
    const reg = new VocabRegistry()
    const m = frameworkManifest()
    m.provides.extKinds.push({ id: "core:foo", baseKind: "class", description: "x" })
    expectRegistryError(() => reg.register(m), "reserved-namespace")
  })

  it("rejects derivedBy prefix under reserved aburi:* namespace", () => {
    const reg = new VocabRegistry()
    const m = langManifest()
    m.provides.derivedByPrefixes.push("aburi:meta")
    expectRegistryError(() => reg.register(m), "reserved-namespace")
  })

  it("rejects framework name under reserved framework:hint", () => {
    // framework:hint is the user-only frameworkHints tier; npm plugins must not own it.
    const reg = new VocabRegistry()
    const m = frameworkManifest()
    m.provides.extKindPrefixes.push("framework:hint")
    expectRegistryError(() => reg.register(m), "reserved-namespace")
  })

  it("rejects framework:hint:something but allows framework:hintsomething (segment boundary)", () => {
    const reg = new VocabRegistry()
    const a = frameworkManifest({ name: "framework-a" })
    a.provides.extKindPrefixes.push("framework:hint:acme")
    expectRegistryError(() => reg.register(a), "reserved-namespace")

    const b = frameworkManifest({ name: "framework-b" })
    b.provides.extKindPrefixes.push("framework:hintsomething")
    // Not in the reserved namespace — boundary respected.
    reg.register(b)
    expect(reg.listPlugins()).toHaveLength(1)
  })
})

describe("VocabRegistry.register (AC3 xPrefix consistency, V8)", () => {
  it("rejects effects manifest whose effect ids do not match its xPrefix", () => {
    const reg = new VocabRegistry()
    const m = effectsManifest({ name: "effects-stripe", xPrefix: "stripe" })
    m.provides.effects.push({ id: "x-acme:charge", description: "x" })
    expectRegistryError(() => reg.register(m), "xprefix-mismatch")
  })

  it("rejects effects manifest whose effectPrefix does not equal x-<xPrefix>", () => {
    const reg = new VocabRegistry()
    const m = effectsManifest({ name: "effects-stripe", xPrefix: "stripe" })
    m.provides.effectPrefixes.push("x-acme")
    expectRegistryError(() => reg.register(m), "xprefix-mismatch")
  })

  it("derives xPrefix from name when not declared (effects-foo → foo)", () => {
    const reg = new VocabRegistry()
    const m = effectsManifest({ name: "effects-prisma" })
    m.provides.effects.push({ id: "x-prisma:create", description: "x" })
    reg.register(m)
    expect(reg.findEffect("x-prisma:create")?.owner.name).toBe("effects-prisma")
  })
})

describe("VocabRegistry.register (AC4 namespace-type mismatch, V5)", () => {
  it("rejects effects plugin that declares framework:* extKinds (schema-then-registry)", () => {
    // The schema's allOf if/then would catch this in real loadPluginManifest, but the
    // registry must still reject it defensively when callers hand it a manifest object
    // constructed in TypeScript without ajv validation.
    const reg = new VocabRegistry()
    const m = effectsManifest({ name: "effects-foo", xPrefix: "foo" })
    m.provides.extKinds.push({ id: "framework:foo:bar", baseKind: "class", description: "x" })
    expectRegistryError(() => reg.register(m), "namespace-type-mismatch")
  })

  it("rejects lang plugin that declares framework names", () => {
    const reg = new VocabRegistry()
    const m = langManifest()
    m.provides.frameworks.push("nestjs")
    expectRegistryError(() => reg.register(m), "namespace-type-mismatch")
  })

  it("rejects framework plugin that declares non-framework extKinds", () => {
    const reg = new VocabRegistry()
    const m = frameworkManifest()
    m.provides.extKinds.push({ id: "fp:match", baseKind: "function", description: "x" })
    expectRegistryError(() => reg.register(m), "namespace-type-mismatch")
  })
})

describe("VocabRegistry.register (AC5 exact duplicate id / prefix, V2/V3)", () => {
  it("rejects duplicate effect id across two plugins", () => {
    const reg = new VocabRegistry()
    const a = effectsManifest({ name: "effects-a", xPrefix: "a" })
    a.provides.effects.push({ id: "x-a:write", description: "x" })
    reg.register(a)
    // Even with different xPrefix, b should fail before xPrefix checks if id is duplicate.
    const b = effectsManifest({ name: "effects-b", xPrefix: "a" })
    b.provides.effects.push({ id: "x-a:write", description: "y" })
    expectRegistryError(() => reg.register(b), "duplicate-id")
  })

  it("rejects duplicate extKind id across two plugins", () => {
    const reg = new VocabRegistry()
    const a = frameworkManifest({ name: "framework-a" })
    a.provides.extKinds.push({ id: "framework:a:controller", baseKind: "class", description: "x" })
    reg.register(a)
    const b = frameworkManifest({ name: "framework-b" })
    b.provides.extKinds.push({ id: "framework:a:controller", baseKind: "class", description: "y" })
    expectRegistryError(() => reg.register(b), "duplicate-id")
  })

  it("rejects duplicate effectPrefixes across two plugins", () => {
    const reg = new VocabRegistry()
    const a = effectsManifest({ name: "effects-acme", xPrefix: "acme" })
    a.provides.effectPrefixes.push("x-acme")
    reg.register(a)
    const b = effectsManifest({ name: "effects-acme2", xPrefix: "acme" })
    b.provides.effectPrefixes.push("x-acme")
    expectRegistryError(() => reg.register(b), "duplicate-prefix")
  })

  it("rejects duplicate framework name", () => {
    const reg = new VocabRegistry()
    const a = frameworkManifest({ name: "framework-a" })
    a.provides.frameworks.push("nestjs")
    reg.register(a)
    const b = frameworkManifest({ name: "framework-b" })
    b.provides.frameworks.push("nestjs")
    expectRegistryError(() => reg.register(b), "duplicate-id")
  })
})

describe("VocabRegistry.register (AC6 prefix vs existing id shadow)", () => {
  it("rejects new id that falls under existing prefix (effect)", () => {
    const reg = new VocabRegistry()
    const a = effectsManifest({ name: "effects-acme", xPrefix: "acme" })
    a.provides.effectPrefixes.push("x-acme")
    reg.register(a)
    // b owns x-acme conceptually too, but actually the registry should detect ANY new id
    // falling under an existing prefix from another plugin.
    const b = effectsManifest({ name: "effects-other", xPrefix: "acme" })
    b.provides.effects.push({ id: "x-acme:charge", description: "x" })
    expectRegistryError(() => reg.register(b), "prefix-shadow-id")
  })

  it("rejects new prefix that would shadow an existing id", () => {
    const reg = new VocabRegistry()
    const a = frameworkManifest({ name: "framework-acme" })
    a.provides.extKinds.push({ id: "framework:acme:job", baseKind: "class", description: "x" })
    reg.register(a)
    const b = frameworkManifest({ name: "framework-other" })
    b.provides.extKindPrefixes.push("framework:acme")
    expectRegistryError(() => reg.register(b), "prefix-shadow-id")
  })
})

describe("VocabRegistry.register (AC7 prefix-prefix containment both directions, V11)", () => {
  it("rejects new prefix that contains an existing prefix (framework:acme then framework:acme:jobs)", () => {
    const reg = new VocabRegistry()
    const a = frameworkManifest({ name: "framework-a" })
    a.provides.extKindPrefixes.push("framework:acme")
    reg.register(a)
    const b = frameworkManifest({ name: "framework-b" })
    b.provides.extKindPrefixes.push("framework:acme:jobs")
    expectRegistryError(() => reg.register(b), "prefix-prefix-overlap")
  })

  it("rejects new prefix that is contained by an existing prefix (other direction)", () => {
    const reg = new VocabRegistry()
    const a = frameworkManifest({ name: "framework-a" })
    a.provides.extKindPrefixes.push("framework:acme:jobs")
    reg.register(a)
    const b = frameworkManifest({ name: "framework-b" })
    b.provides.extKindPrefixes.push("framework:acme")
    expectRegistryError(() => reg.register(b), "prefix-prefix-overlap")
  })

  it("treats segment boundary correctly (framework:acmegrid is NOT under framework:acme)", () => {
    const reg = new VocabRegistry()
    const a = frameworkManifest({ name: "framework-a" })
    a.provides.extKindPrefixes.push("framework:acme")
    reg.register(a)
    const b = frameworkManifest({ name: "framework-b" })
    b.provides.extKindPrefixes.push("framework:acmegrid")
    reg.register(b) // no overlap
    expect(reg.listPlugins()).toHaveLength(2)
  })
})

describe("VocabRegistry.register (atomicity)", () => {
  it("failed register leaves the registry untouched", () => {
    const reg = new VocabRegistry()
    const good = frameworkManifest({ name: "framework-good" })
    good.provides.frameworks.push("nestjs")
    reg.register(good)

    const bad = frameworkManifest({ name: "framework-bad" })
    bad.provides.extKinds.push({ id: "framework:good:thing", baseKind: "class", description: "x" })
    bad.provides.frameworks.push("nestjs") // duplicate, will throw
    expect(() => reg.register(bad)).toThrow(RegistryError)

    // bad's extKinds should NOT have been registered partially.
    expect(reg.findExtKind("framework:good:thing")).toBeNull()
    expect(reg.listPlugins()).toEqual([good])
  })
})

describe("VocabRegistry queries (V10 prefix-owned lookup, V1 listing)", () => {
  it("findEffect returns prefix-owned ids with description=null", () => {
    const reg = new VocabRegistry()
    const m = effectsManifest({ name: "effects-acme", xPrefix: "acme" })
    m.provides.effectPrefixes.push("x-acme")
    reg.register(m)
    const v10 = reg.findEffect("x-acme:anything")
    expect(v10).not.toBeNull()
    expect(v10?.description).toBeNull()
    expect(v10?.owner.name).toBe("effects-acme")
  })

  it("findEffect returns individually-declared ids with their description", () => {
    const reg = new VocabRegistry()
    const m = effectsManifest({ name: "effects-prisma", xPrefix: "prisma" })
    m.provides.effects.push({ id: "x-prisma:create", description: "prisma write" })
    reg.register(m)
    const v = reg.findEffect("x-prisma:create")
    expect(v?.description).toBe("prisma write")
  })

  it("findEffect returns null for unknown ids", () => {
    const reg = new VocabRegistry()
    expect(reg.findEffect("x-nobody:anything")).toBeNull()
  })

  it("findExtKind returns prefix-owned with baseKind=null", () => {
    const reg = new VocabRegistry()
    const m = frameworkManifest({ name: "framework-acme" })
    m.provides.extKindPrefixes.push("framework:acme")
    reg.register(m)
    const v = reg.findExtKind("framework:acme:saga")
    expect(v?.baseKind).toBeNull()
    expect(v?.owner.name).toBe("framework-acme")
  })

  it("list* returns every registered vocab entry (V1)", () => {
    const reg = new VocabRegistry()
    const lang = langManifest({ name: "lang-ts" })
    lang.provides.extKinds.push({ id: "fp:lens", baseKind: "function", description: "x" })
    reg.register(lang)
    const eff = effectsManifest({ name: "effects-prisma", xPrefix: "prisma" })
    eff.provides.effects.push({ id: "x-prisma:read", description: "x" })
    reg.register(eff)
    const fw = frameworkManifest({ name: "framework-nest" })
    fw.provides.frameworks.push("nestjs")
    reg.register(fw)

    expect(reg.listPlugins()).toHaveLength(3)
    expect(reg.listEffects().map((e) => e.id)).toEqual(["x-prisma:read"])
    expect(reg.listExtKinds().map((e) => e.id)).toEqual(["fp:lens"])
    expect(reg.listFrameworks().map((f) => f.name)).toEqual(["nestjs"])
  })
})

describe("VocabRegistry.assert* (AC8 + V6 / V7)", () => {
  it("assertEffectDeclared honours prefix ownership", () => {
    const reg = new VocabRegistry()
    const m = effectsManifest({ name: "effects-acme", xPrefix: "acme" })
    m.provides.effectPrefixes.push("x-acme")
    reg.register(m)
    expect(() => reg.assertEffectDeclared("x-acme:custom", "effects-acme")).not.toThrow()
  })

  it("assertEffectDeclared throws for unknown effect (V6)", () => {
    const reg = new VocabRegistry()
    expectRegistryError(
      () => reg.assertEffectDeclared("x-nope:anything", "effects-acme"),
      "vocab-undeclared",
    )
  })

  it("assertEffectDeclared throws when caller is not the owner", () => {
    const reg = new VocabRegistry()
    const owner = effectsManifest({ name: "effects-acme", xPrefix: "acme" })
    owner.provides.effects.push({ id: "x-acme:charge", description: "x" })
    reg.register(owner)
    expectRegistryError(
      () => reg.assertEffectDeclared("x-acme:charge", "effects-impostor"),
      "vocab-undeclared",
    )
  })

  it("assertExtKindDeclared honours prefix ownership (V7 happy path)", () => {
    const reg = new VocabRegistry()
    const m = frameworkManifest({ name: "framework-acme" })
    m.provides.extKindPrefixes.push("framework:acme")
    reg.register(m)
    expect(() => reg.assertExtKindDeclared("framework:acme:job", "framework-acme")).not.toThrow()
  })

  it("assertExtKindDeclared throws for undeclared id (V7)", () => {
    const reg = new VocabRegistry()
    expectRegistryError(
      () => reg.assertExtKindDeclared("framework:nope:foo", "framework-x"),
      "vocab-undeclared",
    )
  })
})

describe("VocabRegistry.derivedBy lookup", () => {
  it("findDerivedByOwner resolves a prefix-owned value to its owning plugin", () => {
    const reg = new VocabRegistry()
    const m = frameworkManifest({ name: "framework-nest" })
    m.provides.derivedByPrefixes.push("framework:nestjs")
    reg.register(m)
    expect(reg.findDerivedByOwner("framework:nestjs:controller")?.name).toBe("framework-nest")
    expect(reg.findDerivedByOwner("framework:other:thing")).toBeNull()
  })
})
