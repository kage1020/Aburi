import { describe, expect, it } from "vitest"
import { normalizeLineTerminators } from "../../src/scan/scan"

describe("normalizeLineTerminators", () => {
  it("turns CRLF and a lone CR into LF, and leaves LF alone", () => {
    expect(normalizeLineTerminators("a\r\nb\rc\nd\r\n\r\ne\r")).toBe("a\nb\nc\nd\n\ne\n")
  })

  it("returns LF-only content unchanged", () => {
    const content = "export const a = 1\n"
    expect(normalizeLineTerminators(content)).toBe(content)
  })
})
