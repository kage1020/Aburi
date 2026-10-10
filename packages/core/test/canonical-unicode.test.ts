import { describe, expect, it } from "vitest"
import { CoreError, checkIRIntegrity, makeSymbolId, serializeCanonical } from "../src/index"
import { makeSymbol, minimalIR } from "./fixtures/ir"

const NFD_E_ACUTE = "é"
const NFC_E_ACUTE = "é"

describe("serializeCanonical — Unicode key handling", () => {
  it("uses two genuinely different spellings", () => {
    // Guards every case below: if these ever become the same string, they all pass vacuously.
    expect(NFD_E_ACUTE).not.toBe(NFC_E_ACUTE)
    expect(NFD_E_ACUTE.normalize("NFC")).toBe(NFC_E_ACUTE)
  })

  it("emits identical bytes whichever spelling the caller used", () => {
    const decomposed = serializeCanonical({ [`caf${NFD_E_ACUTE}`]: 1, f: 2 }, { format: "compact" })
    const composed = serializeCanonical({ [`caf${NFC_E_ACUTE}`]: 1, f: 2 }, { format: "compact" })

    expect(decomposed).toBe(composed)
  })

  it("orders keys by their normalized form, not their input form", () => {
    const out = serializeCanonical({ [NFD_E_ACUTE]: 1, f: 2 }, { format: "compact" })

    expect(out).toBe(`{"f":2,"${NFC_E_ACUTE}":1}`)
  })

  it("normalizes string values too, so equal text hashes equally", () => {
    const decomposed = serializeCanonical({ k: `caf${NFD_E_ACUTE}` }, { format: "compact" })
    const composed = serializeCanonical({ k: `caf${NFC_E_ACUTE}` }, { format: "compact" })

    expect(decomposed).toBe(composed)
  })

  it("refuses two keys that collide once normalized instead of emitting both", () => {
    expect(() =>
      serializeCanonical({ [NFD_E_ACUTE]: 1, [NFC_E_ACUTE]: 2 }, { format: "compact" }),
    ).toThrow(CoreError)
  })

  it("keeps round-tripping through JSON.parse lossless", () => {
    const source = { [`caf${NFD_E_ACUTE}`]: 1, [`caf${NFD_E_ACUTE}z`]: 2, plain: 3 }

    const parsed = JSON.parse(serializeCanonical(source, { format: "compact" }))

    expect(parsed).toEqual({ [`caf${NFC_E_ACUTE}`]: 1, [`caf${NFC_E_ACUTE}z`]: 2, plain: 3 })
  })

  it("does not treat a collision with an undefined value as a collision", () => {
    expect(
      serializeCanonical({ [NFD_E_ACUTE]: 1, [NFC_E_ACUTE]: undefined }, { format: "compact" }),
    ).toBe(`{"${NFC_E_ACUTE}":1}`)
  })

  it("carries the collision through the pretty format and from inside an array", () => {
    expect(() => serializeCanonical({ items: [{ [NFD_E_ACUTE]: 1, [NFC_E_ACUTE]: 2 }] })).toThrow(
      CoreError,
    )

    try {
      serializeCanonical({ items: [{ [NFD_E_ACUTE]: 1, [NFC_E_ACUTE]: 2 }] })
    } catch (error) {
      const core = error as CoreError & { code?: string; value?: string }
      expect(core.code).toBe("canonical-key-collision")
      expect(core.value).toBe("$.items[0]")
      // The two keys render identically, so the message has to name the code points.
      expect(core.message).toContain("U+0065 U+0301")
      expect(core.message).toContain("U+00E9")
    }
  })
})

describe("Symbol ids are normalized at construction", () => {
  it("gives an NFD and an NFC path the same id", () => {
    const fromDecomposed = makeSymbolId({
      language: "ts",
      file: `src/caf${NFD_E_ACUTE}.ts`,
      qualifiedName: "f",
    })
    const fromComposed = makeSymbolId({
      language: "ts",
      file: `src/caf${NFC_E_ACUTE}.ts`,
      qualifiedName: "f",
    })

    expect(fromDecomposed).toBe(fromComposed)
    expect(fromDecomposed).toBe(fromDecomposed.normalize("NFC"))
  })

  it("keeps the sort the integrity check verifies and the sort on disk the same", () => {
    const ir = minimalIR()
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
    expect(serializeCanonical({ [FULLWIDTH_A]: LIGATURE_FI }, { format: "compact" })).toBe(
      `{"${FULLWIDTH_A}":"${LIGATURE_FI}"}`,
    )
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
