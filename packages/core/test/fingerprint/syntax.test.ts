import { describe, expect, it } from "vitest"
import { syntaxFingerprint } from "../../src/index"

describe("syntaxFingerprint", () => {
  it("produces distinct hashes for structurally different S-expressions", () => {
    const a = '(if_statement condition: (identifier "x"))'
    const b = '(if_statement condition: (identifier "y"))'
    expect(syntaxFingerprint(a)).not.toBe(syntaxFingerprint(b))
  })

  it.each([
    "",
    "  \n\t ",
  ])("refuses %j so a broken language plugin cannot collapse every Symbol to SHA-256(''), the well-known e3b0c44298fc hash", (input) => {
    expect(() => syntaxFingerprint(input)).toThrowError(/empty normalized AST/)
  })
})
