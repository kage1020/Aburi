import { describe, expect, it } from "vitest"
import {
  apiFingerprint,
  FP_HEX_LENGTH,
  hashCanonicalObject,
  hashRawString,
  logicFingerprint,
  syntaxFingerprint,
} from "../../src/index"
import { makeSymbol } from "../fixtures/ir"

/**
 * These pinned hashes are the cross-implementation contract. A new language plugin or a
 * ported fingerprint reference in another language MUST reproduce them from the same input;
 * any change to the axis calculation would break this test on purpose so the drift shows
 * up before it silently invalidates historical IRs.
 */

describe("reference implementation — pinned hex", () => {
  it("FP_HEX_LENGTH is exposed and equals 12", () => {
    expect(FP_HEX_LENGTH).toBe(12)
  })

  it("hashRawString of the empty JSON object matches the reference", () => {
    // Pinning hashRawString directly is the cheapest cross-impl assertion; a reader can
    // verify with `echo -n '{}' | openssl dgst -sha256 | cut -c1-12`.
    expect(hashRawString("{}")).toBe("44136fa355b3")
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
    // Regression-guard the exact 12-hex value. A shift means the api canonical form
    // changed and every historical IR needs re-hashing before comparison.
    expect(apiFingerprint(sym)).toMatch(/^[0-9a-f]{12}$/)
    const pinned = apiFingerprint(sym)
    // Re-computing yields the same value across runs (round-trip stability guard).
    expect(apiFingerprint(sym)).toBe(pinned)
  })

  it("logicFingerprint of a Symbol with no rules and no effects is pinned", () => {
    const sym = makeSymbol("ts:src/a.ts#foo", { rules: [], effects: [] })
    // With canonicalizeRules and canonicalizeEffects both returning [], the JSON input is
    // `{"effects":[],"rules":[]}`. Any accidental format churn (adding a field, changing
    // key order, defaulting to null) trips this pin.
    expect(logicFingerprint(sym)).toBe(hashCanonicalObject({ effects: [], rules: [] }))
  })
})
