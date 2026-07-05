import { describe, expect, it } from "vitest"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, effectsPrismaManifest } from "../src/index"

describe("effectsPrismaManifest", () => {
  it("declares the effects-prisma name and effects type", () => {
    expect(effectsPrismaManifest.name).toBe("effects-prisma")
    expect(effectsPrismaManifest.type).toBe("effects")
  })

  it("does not declare any effect ids — core db.* vocabulary is used at classify() return", () => {
    // Core vocab (`db.read`, `db.write`, `db.transaction`) is owned by the core engine
    // per extension-vocab.md §5.1 (reserved namespaces) and MUST NOT appear in a
    // plugin's provides.effects — validated at registry load time.
    expect(effectsPrismaManifest.provides.effects).toEqual([])
    expect(effectsPrismaManifest.provides.effectPrefixes).toEqual([])
  })

  it("declares no framework or extKind vocabulary (effects plugins are forbidden from doing so)", () => {
    expect(effectsPrismaManifest.provides.frameworks).toEqual([])
    expect(effectsPrismaManifest.provides.extKinds).toEqual([])
    expect(effectsPrismaManifest.provides.extKindPrefixes).toEqual([])
  })

  it("owns the effects-plugin:prisma derivedBy prefix", () => {
    expect(effectsPrismaManifest.provides.derivedByPrefixes).toEqual(["effects-plugin:prisma"])
  })

  it("references the shared derivedBy prefix constant (single source of truth)", () => {
    // The manifest's declared prefix and the classifier's tag builder must not drift
    // apart across edits — pin they refer to the same literal.
    expect(effectsPrismaManifest.provides.derivedByPrefixes).toEqual([
      EFFECTS_PRISMA_DERIVED_BY_PREFIX,
    ])
    expect(EFFECTS_PRISMA_DERIVED_BY_PREFIX).toBe("effects-plugin:prisma")
  })

  it("targets aburi engine with a wildcard version (v0.1 pre-1.0 compatibility posture)", () => {
    expect(effectsPrismaManifest.engines).toEqual({ aburi: "*" })
  })

  it("references the aburi.plugin.v1 schema", () => {
    expect(effectsPrismaManifest.$schema).toBe("https://aburi.dev/schema/aburi.plugin.v1.json")
  })
})
