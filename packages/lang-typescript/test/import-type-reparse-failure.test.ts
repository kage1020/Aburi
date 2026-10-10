import { describe, expect, it, vi } from "vitest"
import { parseSource } from "./fixtures/ctx"

vi.mock("../src/import-type-reparse", async (importActual) => ({
  ...(await importActual<typeof import("../src/import-type-reparse")>()),
  reparseImportTypes: () => {
    throw new Error("out of memory")
  },
}))

describe("LP27b — an import() type reparse that throws", () => {
  it("keeps the first parse and names the failed pass beside its errors", async () => {
    const result = await parseSource('export const b = g<typeof import("./m")>()\n')
    expect(result.tree).not.toBeNull()
    expect(result.errors.map((e) => [e.message, e.recoverable])).toEqual([
      ["import() type reparse failed, keeping the first parse: out of memory", true],
      ["syntax error", true],
    ])
  })
})
