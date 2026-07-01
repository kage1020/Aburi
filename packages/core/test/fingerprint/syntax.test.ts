import { describe, expect, it } from "vitest"
import { syntaxFingerprint } from "../../src/index"

describe("syntaxFingerprint", () => {
  it("returns exactly 12 lowercase hex characters", () => {
    expect(syntaxFingerprint('(function_declaration (identifier "foo"))')).toMatch(/^[0-9a-f]{12}$/)
  })

  it("is deterministic for a given input", () => {
    const input =
      '(method_definition name: (property_identifier "createInvoice") body: (statement_block))'
    expect(syntaxFingerprint(input)).toBe(syntaxFingerprint(input))
  })

  it("produces distinct hashes for structurally different S-expressions", () => {
    const a = '(if_statement condition: (identifier "x"))'
    const b = '(if_statement condition: (identifier "y"))'
    expect(syntaxFingerprint(a)).not.toBe(syntaxFingerprint(b))
  })

  it("refuses empty input so a broken language plugin cannot collapse every Symbol to SHA-256(''), the well-known e3b0c44298fc hash", () => {
    expect(() => syntaxFingerprint("")).toThrowError(/empty normalized AST/)
  })

  it("refuses whitespace-only input for the same reason", () => {
    expect(() => syntaxFingerprint("  \n\t ")).toThrowError(/empty normalized AST/)
  })
})
