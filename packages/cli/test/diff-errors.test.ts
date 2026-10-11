import { DiffError } from "@aburi/diff"
import { describe, expect, it } from "vitest"
import { classifyDiffError } from "../src"

describe("classifyDiffError — a DiffError onto the exit-code table", () => {
  it.each([
    "schema-mismatch",
    "invalid-line-fuzz",
    "ir-shape-invalid",
    "ir-identity-collision",
  ] as const)("reports %s as the reader's to fix, in its own words", (code) => {
    const cliError = classifyDiffError(new DiffError(`boom: ${code}`, { code }))
    expect(cliError.code).toBe("config-error")
    expect(cliError.message).toBe(`boom: ${code}`)
  })

  it("reports a Slice that breaks its own derivation as a bug in Aburi, on its own line", () => {
    const cause = new DiffError("SliceRecord slice:a: members[] is empty.", {
      code: "slice-invariant-violated",
      value: "slice:a",
    })
    const cliError = classifyDiffError(cause)
    expect(cliError.code).toBe("runtime-error")
    expect(cliError.message).toContain(
      "members[] is empty.\nThis is a bug in Aburi, not in your configuration",
    )
    expect(cliError.cause).toBe(cause)
  })

  it("keeps what a code it has no arm for said, rather than throwing it away", () => {
    const cause = new DiffError("Symbol sym:a: fingerprint is not a string.", {
      code: "symbol-fingerprint-invalid",
    } as unknown as ConstructorParameters<typeof DiffError>[1])

    const cliError = classifyDiffError(cause)

    expect(cliError.code).toBe("runtime-error")
    expect(cliError.message).toContain("fingerprint is not a string")
    expect(cliError.message).toContain("symbol-fingerprint-invalid")
    expect(cliError.cause).toBe(cause)
  })
})
