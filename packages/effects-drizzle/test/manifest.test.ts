import { describe, expect, it } from "vitest"
import { EFFECTS_DRIZZLE_DERIVED_BY_PREFIX, effectsDrizzleManifest } from "../src/index"

describe("effectsDrizzleManifest", () => {
  it("declares the effects-drizzle name and effects type", () => {
    expect(effectsDrizzleManifest.name).toBe("effects-drizzle")
    expect(effectsDrizzleManifest.type).toBe("effects")
  })

  it("does not declare any effect ids — core db.* vocabulary is used at classify() return", () => {
    // Core vocab (`db.read`, `db.write`, `db.transaction`) is owned by the core engine
    // per extension-vocab.md §5.1 (reserved namespaces) and MUST NOT appear in a
    // plugin's provides.effects — validated at registry load time.
    expect(effectsDrizzleManifest.provides.effects).toEqual([])
    expect(effectsDrizzleManifest.provides.effectPrefixes).toEqual([])
  })

  it("declares no framework or extKind vocabulary (effects plugins are forbidden from doing so)", () => {
    expect(effectsDrizzleManifest.provides.frameworks).toEqual([])
    expect(effectsDrizzleManifest.provides.extKinds).toEqual([])
    expect(effectsDrizzleManifest.provides.extKindPrefixes).toEqual([])
  })

  it("owns the effects-plugin:drizzle derivedBy prefix", () => {
    expect(effectsDrizzleManifest.provides.derivedByPrefixes).toEqual(["effects-plugin:drizzle"])
  })

  it("references the shared derivedBy prefix constant (single source of truth)", () => {
    // The manifest's declared prefix and the classifier's tag builder must not drift
    // apart across edits — pin they refer to the same literal.
    expect(effectsDrizzleManifest.provides.derivedByPrefixes).toEqual([
      EFFECTS_DRIZZLE_DERIVED_BY_PREFIX,
    ])
    expect(EFFECTS_DRIZZLE_DERIVED_BY_PREFIX).toBe("effects-plugin:drizzle")
  })

  it("targets aburi engine with a wildcard version (pre-1.0 compatibility posture)", () => {
    expect(effectsDrizzleManifest.engines).toEqual({ aburi: "*" })
  })

  it("references the aburi.plugin.v1 schema", () => {
    expect(effectsDrizzleManifest.$schema).toBe(
      "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    )
  })
})
