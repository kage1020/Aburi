import { describe, expect, it } from "vitest"
import { CoreError, checkIRIntegrity, makeSymbolId, serializeCanonical } from "../src/index"
import { makeSymbol, minimalIR } from "./fixtures/ir"

/**
 * Unicode normalization, from the serializer's side. ir-schema.md §1.2 states the rule and
 * why the Document depends on it; what these cases pin is the ordering half — normalize
 * first, then order. Doing it the other way round orders by one spelling and emits another,
 * so byte-identical inputs stop producing byte-identical output and the fingerprints built
 * on them diverge.
 */

// Escapes, not literal characters: a formatter or editor that NFC-normalizes this file
// would collapse the two constants into one string and turn every case below into a
// tautology that still passes.
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

    // Keys *and* values: a length check alone would accept three different keys, or three
    // right keys carrying the wrong values.
    expect(parsed).toEqual({ [`caf${NFC_E_ACUTE}`]: 1, [`caf${NFC_E_ACUTE}z`]: 2, plain: 3 })
  })

  it("does not treat a collision with an undefined value as a collision", () => {
    // `undefined` keys are dropped before the check, so only one key is written and nothing
    // is lost. Moving that skip below the check would turn every IR carrying an optional
    // field beside a Unicode sibling into a hard scan failure.
    expect(
      serializeCanonical({ [NFD_E_ACUTE]: 1, [NFC_E_ACUTE]: undefined }, { format: "compact" }),
    ).toBe(`{"${NFC_E_ACUTE}":1}`)
  })

  it("carries the collision through the pretty format and from inside an array", () => {
    // `pretty` is the default and what `aburi scan` writes, and a collision nested in an
    // array is the shape whose `path` is worth reporting.
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

describe("NFC, not NFKC", () => {
  // The choice of normalization form is a decision, not a detail. NFC composes characters
  // that are canonically equivalent — the same character, spelled two ways. NFKC additionally
  // folds compatibility characters: `ﬁ` becomes `fi`, fullwidth `Ａ` becomes `A`. Those are
  // different characters, so folding them rewrites the text rather than respelling it.
  const LIGATURE_FI = "\uFB01"
  const FULLWIDTH_A = "\uFF21"

  it("preserves compatibility characters in values and keys", () => {
    // Under NFKC this would emit `{"A":"fi"}` — a Document quoting source text that never
    // appeared in the source.
    expect(serializeCanonical({ [FULLWIDTH_A]: LIGATURE_FI }, { format: "compact" })).toBe(
      `{"${FULLWIDTH_A}":"${LIGATURE_FI}"}`,
    )
  })

  it("keeps two ids that differ only by a compatibility character distinct", () => {
    // Under NFKC both collapse onto `ts:src/file.ts#f`, so two Symbols would share one id
    // and invariant #1 would report a duplicate the source does not contain.
    const ligature = makeSymbolId({
      language: "ts",
      file: `src/${LIGATURE_FI}le.ts`,
      qualifiedName: "f",
    })
    const ascii = makeSymbolId({ language: "ts", file: "src/file.ts", qualifiedName: "f" })
    expect(ligature).not.toBe(ascii)
  })
})
