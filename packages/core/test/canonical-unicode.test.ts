import { makeIR } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CoreError, checkIRIntegrity, makeSymbolId, serializeCanonical } from "../src/index"
import { makeSymbol } from "./fixtures/ir"

const NFD_E_ACUTE = "e\u0301"
const NFC_E_ACUTE = "\u00e9"

function compact(value: unknown): string {
  return serializeCanonical(value, { format: "compact" })
}

describe("serializeCanonical — Unicode", () => {
  it("normalizes keys before it orders them", () => {
    expect(compact({ [NFD_E_ACUTE]: 1, f: 2 })).toBe(`{"f":2,"${NFC_E_ACUTE}":1}`)
  })

  it("normalizes string values, so equal text hashes equally", () => {
    expect(compact({ k: `caf${NFD_E_ACUTE}` })).toBe(compact({ k: `caf${NFC_E_ACUTE}` }))
  })

  it("refuses two keys that collide once normalized, naming both by code point", () => {
    const colliding = { items: [{ [NFD_E_ACUTE]: 1, [NFC_E_ACUTE]: 2 }] }
    expect(() => serializeCanonical(colliding)).toThrow(CoreError)
    expect(() => serializeCanonical(colliding)).toThrowError(
      expect.objectContaining({
        code: "canonical-key-collision",
        value: "$.items[0]",
        message: expect.stringMatching(/U\+0065 U\+0301.*U\+00E9/),
      }),
    )
  })

  it("does not count a key whose value is undefined as a collision", () => {
    expect(compact({ [NFD_E_ACUTE]: 1, [NFC_E_ACUTE]: undefined })).toBe(`{"${NFC_E_ACUTE}":1}`)
  })

  it("keeps the order the integrity check verifies and the order on disk the same", () => {
    const ir = makeIR()
    ir.symbols = [
      makeSymbol(
        makeSymbolId({ language: "ts", file: `src/caf${NFD_E_ACUTE}.ts`, qualifiedName: "f" }),
      ),
      makeSymbol(makeSymbolId({ language: "ts", file: "src/cafz.ts", qualifiedName: "f" })),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    expect(checkIRIntegrity(ir).filter((v) => v.invariant === 11)).toEqual([])

    const written = JSON.parse(serializeCanonical(ir)) as { symbols: { id: string }[] }
    const writtenIds = written.symbols.map((s) => s.id)
    expect(writtenIds).toEqual([...writtenIds].sort())
  })
})

describe("NFC, not NFKC", () => {
  const LIGATURE_FI = "\uFB01"
  const FULLWIDTH_A = "\uFF21"

  it("preserves compatibility characters in values and keys", () => {
    expect(compact({ [FULLWIDTH_A]: LIGATURE_FI })).toBe(`{"${FULLWIDTH_A}":"${LIGATURE_FI}"}`)
  })

  it("keeps two ids that differ only by a compatibility character distinct", () => {
    const ligature = makeSymbolId({
      language: "ts",
      file: `src/${LIGATURE_FI}le.ts`,
      qualifiedName: "f",
    })
    const ascii = makeSymbolId({ language: "ts", file: "src/file.ts", qualifiedName: "f" })
    expect(ligature).not.toBe(ascii)
  })
})
