import { describe, expect, it } from "vitest"
import { EFFECTS_NEST_DERIVED_BY_PREFIX, effectsNestManifest } from "../src/index"

describe("effectsNestManifest", () => {
  it("declares the effects-nest name and effects type", () => {
    expect(effectsNestManifest.name).toBe("effects-nest")
    expect(effectsNestManifest.type).toBe("effects")
  })

  it("does not declare any effect ids — core event.publish is used at classify() return", () => {
    // Core vocab (`event.publish`) is owned by the core engine per extension-vocab.md
    // §5.1 (reserved namespaces) and MUST NOT appear in a plugin's provides.effects —
    // validated at registry load time.
    expect(effectsNestManifest.provides.effects).toEqual([])
    expect(effectsNestManifest.provides.effectPrefixes).toEqual([])
  })

  it("declares no framework or extKind vocabulary (effects plugins are forbidden from doing so)", () => {
    expect(effectsNestManifest.provides.frameworks).toEqual([])
    expect(effectsNestManifest.provides.extKinds).toEqual([])
    expect(effectsNestManifest.provides.extKindPrefixes).toEqual([])
  })

  it("owns the effects-plugin:nest derivedBy prefix", () => {
    expect(effectsNestManifest.provides.derivedByPrefixes).toEqual(["effects-plugin:nest"])
  })

  it("references the shared derivedBy prefix constant (single source of truth)", () => {
    expect(effectsNestManifest.provides.derivedByPrefixes).toEqual([EFFECTS_NEST_DERIVED_BY_PREFIX])
    expect(EFFECTS_NEST_DERIVED_BY_PREFIX).toBe("effects-plugin:nest")
  })

  it("targets aburi engine with a wildcard version (pre-1.0 compatibility posture)", () => {
    expect(effectsNestManifest.engines).toEqual({ aburi: "*" })
  })

  it("references the aburi.plugin.v1 schema", () => {
    expect(effectsNestManifest.$schema).toBe(
      "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    )
  })
})
