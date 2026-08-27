import { describe, expect, it } from "vitest"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX, effectsTrpcManifest } from "../src/index"

describe("effectsTrpcManifest", () => {
  it("declares the effects-trpc name and effects type", () => {
    expect(effectsTrpcManifest.name).toBe("effects-trpc")
    expect(effectsTrpcManifest.type).toBe("effects")
  })

  it("does not declare any effect ids — the core network.rpc vocabulary is used at classify() return", () => {
    // `network.rpc` is core vocabulary (ir-schema.md §9.1) owned by the engine. Per
    // extension-vocab.md §5.1 a plugin MUST NOT declare it in provides.effects; the
    // registry rejects the manifest at load time if it does.
    expect(effectsTrpcManifest.provides.effects).toEqual([])
    expect(effectsTrpcManifest.provides.effectPrefixes).toEqual([])
  })

  it("declares no framework or extKind vocabulary (effects plugins are forbidden from doing so)", () => {
    // The server-side router surface would need `framework:trpc:*` extKinds, which a
    // type=effects manifest cannot own — that split is why routers are out of scope here.
    expect(effectsTrpcManifest.provides.frameworks).toEqual([])
    expect(effectsTrpcManifest.provides.extKinds).toEqual([])
    expect(effectsTrpcManifest.provides.extKindPrefixes).toEqual([])
  })

  it("owns the effects-plugin:trpc derivedBy prefix", () => {
    expect(effectsTrpcManifest.provides.derivedByPrefixes).toEqual(["effects-plugin:trpc"])
  })

  it("references the shared derivedBy prefix constant (single source of truth)", () => {
    expect(effectsTrpcManifest.provides.derivedByPrefixes).toEqual([EFFECTS_TRPC_DERIVED_BY_PREFIX])
    expect(EFFECTS_TRPC_DERIVED_BY_PREFIX).toBe("effects-plugin:trpc")
  })

  it("targets aburi engine with a wildcard version (pre-1.0 compatibility posture)", () => {
    expect(effectsTrpcManifest.engines).toEqual({ aburi: "*" })
  })

  it("references the aburi.plugin.v1 schema", () => {
    expect(effectsTrpcManifest.$schema).toBe(
      "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    )
  })
})
