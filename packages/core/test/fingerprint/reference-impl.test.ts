import { describe, expect, it } from "vitest"
import {
  apiFingerprint,
  hashCanonicalObject,
  hashRawString,
  logicFingerprint,
  syntaxFingerprint,
} from "../../src/index"
import { makeSymbol } from "../fixtures/ir"

describe("reference implementation — pinned hex", () => {
  it("hashRawString of the empty JSON object matches the reference, at 12 lowercase hex", () => {
    expect(hashRawString("{}")).toBe("44136fa355b3")
    expect(hashRawString("anything else")).toMatch(/^[0-9a-f]{12}$/)
  })

  it("hashCanonicalObject of {} produces the same hash as hashRawString('{}')", () => {
    expect(hashCanonicalObject({})).toBe("44136fa355b3")
  })

  it("hashCanonicalObject sorts keys before hashing so {a:1,b:2} == {b:2,a:1}", () => {
    expect(hashCanonicalObject({ a: 1, b: 2 })).toBe(hashCanonicalObject({ b: 2, a: 1 }))
  })

  it("syntaxFingerprint of a fixed S-expression string matches the reference", () => {
    // echo -n '(function_declaration (identifier "foo"))' | sha256sum | cut -c1-12
    expect(syntaxFingerprint('(function_declaration (identifier "foo"))')).toBe("5bae34d2c0a4")
  })

  it("apiFingerprint of a minimal Symbol is pinned", () => {
    const sym = makeSymbol("ts:src/a.ts#foo", {
      kind: "function",
      name: "foo",
      visibility: "public",
      signature: null,
    })
    expect(apiFingerprint(sym)).toBe("abf3a0597098")
  })

  it("apiFingerprint of a parameter with neither marker is pinned, `false` included", () => {
    // `optional` and `rest` enter the input only when true, so a parameter carrying neither
    // hashes exactly as a Document without the fields does. A shift here re-hashes every
    // function in every stored IR, not only those with an optional or rest parameter.
    const withInputs = (inputs: Array<{ name: string; type: string }>) =>
      makeSymbol("ts:src/a.ts#find", {
        kind: "function",
        name: "find",
        visibility: "public",
        signature: {
          inputs,
          outputs: ["User[]"],
          throws: [],
          async: false,
          generator: false,
          typeParameters: [],
        },
      })
    const plain = [
      { name: "query", type: "string" },
      { name: "ids", type: "string[]" },
    ]
    expect(apiFingerprint(withInputs(plain))).toBe("a1f625081136")
    // A producer that writes `false` against the Class B rule means "absent", and is read so.
    const writtenFalse = plain.map((input) => ({ ...input, optional: false, rest: false }))
    expect(apiFingerprint(withInputs(writtenFalse))).toBe("a1f625081136")
  })

  it("logicFingerprint of a Symbol with no rules and no effects is pinned", () => {
    const sym = makeSymbol("ts:src/a.ts#foo", { rules: [], effects: [] })
    expect(logicFingerprint(sym)).toBe(hashCanonicalObject({ effects: [], rules: [] }))
  })
})
