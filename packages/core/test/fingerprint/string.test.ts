import { describe, expect, it } from "vitest"
import { normalizeFingerprintString } from "../../src/index"

describe("normalizeFingerprintString", () => {
  it("NFC-normalizes composed vs decomposed forms to the same output", () => {
    // "café" as one composed é vs "café" as e + combining acute
    expect(normalizeFingerprintString("café")).toBe(normalizeFingerprintString("café"))
  })

  it("collapses runs of whitespace into a single space", () => {
    expect(normalizeFingerprintString("a  \t\n  b")).toBe("a b")
  })

  it("trims leading and trailing whitespace", () => {
    expect(normalizeFingerprintString("  x  ")).toBe("x")
  })

  it("returns an empty string for an all-whitespace input", () => {
    expect(normalizeFingerprintString("  \n\t ")).toBe("")
  })

  it("passes an empty string through unchanged", () => {
    expect(normalizeFingerprintString("")).toBe("")
  })
})
