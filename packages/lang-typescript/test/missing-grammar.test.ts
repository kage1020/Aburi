import { describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importActual) => ({
  ...(await importActual<typeof import("node:fs")>()),
  existsSync: () => false,
}))

describe("a checkout whose grammars were never built", () => {
  it("refuses to load the parser, naming the file it looked for", async () => {
    await expect(import("../src/parser")).rejects.toThrow(
      /no grammar wasm at .*tree-sitter-typescript\.wasm/,
    )
  })
})
