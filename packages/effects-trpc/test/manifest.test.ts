import { describe, expect, it } from "vitest"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX, effectsTrpcManifest } from "../src/index"

describe("effectsTrpcManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
    // The core `network.rpc` id (ir-schema.md) is returned from classify() and MUST
    // NOT appear in provides.effects (extension-vocab.md). The empty extKinds is also
    // why the server-side router surface is out of scope: it would need `framework:trpc:*`
    // extKinds, which a type=effects manifest cannot own.
    expect(effectsTrpcManifest).toEqual({
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
      name: "effects-trpc",
      version: "0.0.0",
      type: "effects",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: ["effects-plugin:trpc"],
        frameworks: [],
      },
    })
  })

  it("shares its derivedBy prefix with the classifier's tag builder", () => {
    expect(effectsTrpcManifest.provides.derivedByPrefixes).toEqual([EFFECTS_TRPC_DERIVED_BY_PREFIX])
  })
})
