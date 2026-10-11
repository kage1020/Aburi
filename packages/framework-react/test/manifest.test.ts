import { describe, expect, it } from "vitest"
import { frameworkReactManifest, REACT_EXT_KINDS } from "../src/index"

describe("frameworkReactManifest", () => {
  it("declares the react framework, owning the framework:react prefixes and no effects", () => {
    expect(frameworkReactManifest).toMatchObject({
      name: "framework-react",
      type: "framework",
      provides: {
        effects: [],
        effectPrefixes: [],
        extKindPrefixes: ["framework:react"],
        derivedByPrefixes: ["framework:react"],
        frameworks: ["react"],
      },
    })
  })

  it("declares each extKind the classifier assigns, on the kind it falls back to", () => {
    expect(frameworkReactManifest.provides.extKinds.map((e) => [e.id, e.baseKind])).toEqual([
      ["framework:react:component", "function"],
      ["framework:react:hook", "function"],
      ["framework:react:context", "const"],
      ["framework:react:forward-ref", "const"],
      ["framework:react:memo", "const"],
      ["framework:react:provider", "function"],
      ["framework:react:hoc", "function"],
    ])
    expect(frameworkReactManifest.provides.extKinds.map((e) => e.id)).toEqual([...REACT_EXT_KINDS])
  })
})
