import { describe, expect, it } from "vitest"
import { normalizeFingerprintString } from "../../src/index"

describe("normalizeFingerprintString", () => {
  it.each([
    ["composes a decomposed spelling", "cafe\u0301", "caf\u00e9"],
    ["collapses each whitespace run to one space", "a  \t\n  b", "a b"],
    ["trims both ends", "  x  ", "x"],
    ["reduces whitespace alone to nothing", "  \n\t ", ""],
    ["passes an empty string through", "", ""],
  ])("%s", (_what, input, normalized) => {
    expect(normalizeFingerprintString(input)).toBe(normalized)
  })
})
