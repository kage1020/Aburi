import { describe, expect, it } from "vitest"
import { frameworkTrpcManifest, TRPC_EXT_KINDS, trpcFrameworkPlugin } from "../src/index"

describe("frameworkTrpcManifest", () => {
  it("declares the trpc framework, owning the framework:trpc prefixes and no effects", () => {
    expect(trpcFrameworkPlugin.manifest).toBe(frameworkTrpcManifest)
    expect(frameworkTrpcManifest).toMatchObject({
      name: "framework-trpc",
      type: "framework",
      provides: {
        effects: [],
        effectPrefixes: [],
        extKindPrefixes: ["framework:trpc"],
        derivedByPrefixes: ["framework:trpc"],
        frameworks: ["trpc"],
      },
    })
  })

  it("declares each extKind the classifier assigns, every one on a const", () => {
    expect(frameworkTrpcManifest.provides.extKinds.map((e) => [e.id, e.baseKind])).toEqual([
      ["framework:trpc:instance", "const"],
      ["framework:trpc:router", "const"],
      ["framework:trpc:procedure", "const"],
      ["framework:trpc:base-procedure", "const"],
      ["framework:trpc:middleware", "const"],
    ])
    expect(frameworkTrpcManifest.provides.extKinds.map((e) => e.id)).toEqual([...TRPC_EXT_KINDS])
  })
})
