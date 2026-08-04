import { describe, expect, it } from "vitest"
import { CoreError, checkIRIntegrity, makeSymbolId, serializeCanonical } from "../src/index"
import { makeSymbol, minimalIR } from "./fixtures/ir"

/**
 * The same text can be spelled two ways in Unicode: `é` as one code point (NFC, U+00E9) or
 * as `e` plus a combining acute (NFD, U+0065 U+0301). Filesystems differ on which they
 * hand back — macOS decomposes, Linux and Windows do not — so the same source tree
 * produces differently-spelled paths depending on where it was scanned.
 *
 * Canonical serialization is what makes that invisible: normalize first, then order. Doing
 * it the other way round orders by one spelling and emits another, so byte-identical
 * inputs stop producing byte-identical output and the fingerprints built on it diverge.
 */

const NFD_E_ACUTE = "é"
const NFC_E_ACUTE = "é"

describe("serializeCanonical — Unicode key handling", () => {
  it("emits identical bytes whichever spelling the caller used", () => {
    const decomposed = serializeCanonical({ [`caf${NFD_E_ACUTE}`]: 1, f: 2 }, { format: "compact" })
    const composed = serializeCanonical({ [`caf${NFC_E_ACUTE}`]: 1, f: 2 }, { format: "compact" })

    expect(decomposed).toBe(composed)
  })

  it("orders keys by their normalized form, not their input form", () => {
    // `e` (U+0065) sorts before `f`; `é` (U+00E9) sorts after. Sorting the raw NFD spelling
    // would put the accented key first and then write it composed — an output whose own
    // key order is wrong for the bytes it contains.
    const out = serializeCanonical({ [NFD_E_ACUTE]: 1, f: 2 }, { format: "compact" })

    expect(out).toBe(`{"f":2,"${NFC_E_ACUTE}":1}`)
  })

  it("normalizes string values too, so equal text hashes equally", () => {
    const decomposed = serializeCanonical({ k: `caf${NFD_E_ACUTE}` }, { format: "compact" })
    const composed = serializeCanonical({ k: `caf${NFC_E_ACUTE}` }, { format: "compact" })

    expect(decomposed).toBe(composed)
  })

  it("refuses two keys that collide once normalized instead of emitting both", () => {
    // Writing both produces `{"é":1,"é":2}` — valid-looking JSON that silently loses an
    // entry on the next `JSON.parse`. Same reasoning as the non-JSON-value rejection:
    // a lossy coercion is worse than a loud failure.
    expect(() =>
      serializeCanonical({ [NFD_E_ACUTE]: 1, [NFC_E_ACUTE]: 2 }, { format: "compact" }),
    ).toThrow(CoreError)
  })

  it("keeps round-tripping through JSON.parse lossless", () => {
    const source = { [`caf${NFD_E_ACUTE}`]: 1, [`caf${NFD_E_ACUTE}z`]: 2, plain: 3 }
    const parsed = JSON.parse(serializeCanonical(source, { format: "compact" }))

    expect(Object.keys(parsed)).toHaveLength(3)
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

  // The qualified name is normalized on the same path, but a non-ASCII qname cannot reach
  // the constructor today: `QNAME_SEGMENT_PATTERN` is ASCII-only and rejects it first. A
  // case for that belongs with the grammar widening, not here.

  /**
   * Invariant #11 compares ids in memory while the writer emits them normalized. If the two
   * spellings could differ, a document could pass the sort check and land on disk out of
   * order — the check would be measuring a string nobody ever writes.
   */
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
