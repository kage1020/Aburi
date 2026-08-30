import type { Component, IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, DiffError } from "../src"
import { component, fp, makeIR, makeSymbol } from "./fixtures"

/**
 * `buildDiff` is public API and ran no integrity check, so an IR a caller assembled in memory
 * reached the matcher unverified — this file pins the gate that closed that.
 *
 * Measured beforehand, one field deleted at a time from a well-formed pair: `fingerprint` and
 * `source` crashed `classifyStatus`, `rules` / `effects` / `calls` / `decorators` crashed
 * `computeSymbolDelta`, `components[].roots` crashed `diffComponents`, and `stats` crashed
 * `dependencySideView` — each a `TypeError` naming neither the record nor the field.
 *
 * The gate is invariant #20 alone (`checkDocumentShape`), not the whole checker. It
 * establishes what the `IR` brand asserts; the semantic rules are about a Document whose
 * answer the diff does not depend on, and running them would refuse an IR the diff can read.
 */

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

/** A pair whose Symbol genuinely changed, so the delta path — where four of the crashes lived — runs. */
function changedPair(): { base: IR; head: IR } {
  return {
    base: makeIR({ symbols: [makeSymbol({ id: "ts:src/a.ts#f", name: "f" })] }),
    head: makeIR({
      symbols: [makeSymbol({ id: "ts:src/a.ts#f", name: "f", fingerprint: fp("bbb") })],
    }),
  }
}

function diffOf(base: IR, head: IR) {
  return buildDiff({ baseIR: base, headIR: head, base: IR_REF, head: IR_REF })
}

function caught(base: IR, head: IR): DiffError {
  try {
    diffOf(base, head)
  } catch (error) {
    if (error instanceof DiffError) return error
    throw error
  }
  throw new Error("expected buildDiff to refuse this IR")
}

function withoutSymbolField(field: string): IR {
  const { head } = changedPair()
  const symbol = { ...head.symbols[0] } as Record<string, unknown>
  delete symbol[field]
  return { ...head, symbols: [symbol as unknown as IRSymbol] }
}

describe("a Symbol missing a field the diff reads is named, not crashed on", () => {
  it.each([
    "fingerprint",
    "source",
    "calls",
    "decorators",
    "effects",
    "rules",
  ])("names headIR.symbols[0] and %s", (field) => {
    const { base } = changedPair()
    const error = caught(base, withoutSymbolField(field))

    expect(error.code).toBe("ir-shape-invalid")
    // The record and the field are the whole point: the `TypeError` each of these used to
    // raise named neither, and a caller holding a thousand Symbols had nowhere to look.
    expect(error.message).toContain("headIR.symbols[0]")
    expect(error.message).toContain(`"${field}"`)
  })

  it.each([
    "signature",
    "component",
  ])("accepts an absent %s, which the schema makes optional", (field) => {
    const { base } = changedPair()

    // The gate follows the schema's own optionality rather than requiring every key. These
    // two are `optional(nullable(...))` in `aburi.ir.v1`, so absent is a document a writer
    // predating the field would produce, and the diff reads both through a null check.
    expect(() => diffOf(base, withoutSymbolField(field))).not.toThrow()
  })

  it("refuses a fingerprint that is present but not an object", () => {
    const { base, head } = changedPair()
    const broken = { ...head.symbols[0], fingerprint: "aaa" } as unknown as IRSymbol
    const error = caught(base, { ...head, symbols: [broken] })

    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toContain(`"fingerprint"`)
  })
})

describe("a field the diff never reads is refused too, and that is deliberate", () => {
  it.each([
    "visibility",
    "name",
    "kind",
    "language",
    "confidence",
    "derivedBy",
  ])("refuses a Symbol missing %s", (field) => {
    const { base } = changedPair()
    const error = caught(base, withoutSymbolField(field))

    // A widening: each of these used to produce an answer, because nothing in the matcher
    // happened to dereference it. What the gate establishes is what the `IR` brand asserts
    // rather than what today's matcher touches — scoping it to the latter would move with
    // every change to the matcher and leave a caller's IR conditionally valid.
    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toContain(`"${field}"`)
  })
})

describe("the malformed entry is located, not merely reported", () => {
  it("names the index it is at, not the first", () => {
    const symbols = ["a", "b", "c", "d"].map((n) => makeSymbol({ id: `ts:src/${n}.ts#f`, name: n }))
    const head = makeIR({ symbols })
    const broken = { ...symbols[3] } as Record<string, unknown>
    delete broken.source
    const error = caught(makeIR({ symbols }), {
      ...head,
      symbols: [...symbols.slice(0, 3), broken as unknown as IRSymbol],
    })

    expect(error.message).toContain("headIR.symbols[3]")
    expect(error.message).not.toContain("symbols[0]")
  })

  it("names a Component field, and the base side when that is the broken one", () => {
    const good = component({ id: "core", name: "core" })
    const broken = { ...good } as Record<string, unknown>
    delete broken.roots
    const error = caught(makeIR({ components: [broken as unknown as Component] }), makeIR())

    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toContain("baseIR.components[0]")
    expect(error.message).toContain(`"roots"`)
  })

  it("names baseIR when both sides are broken, because a caller has to know which", () => {
    const brokenSymbol = () => {
      const s = { ...makeSymbol({ id: "ts:src/a.ts#f", name: "f" }) } as Record<string, unknown>
      delete s.source
      return s as unknown as IRSymbol
    }
    const error = caught(
      makeIR({ symbols: [brokenSymbol()] }),
      makeIR({ symbols: [brokenSymbol()] }),
    )

    expect(error.message).toContain("baseIR")
    expect(error.message).not.toContain("headIR")
  })

  it("quotes one breach, counts the rest, and carries all of them", () => {
    const { base } = changedPair()
    const symbol = { ...changedPair().head.symbols[0] } as Record<string, unknown>
    delete symbol.source
    delete symbol.calls
    delete symbol.rules
    const error = caught(base, { ...base, symbols: [symbol as unknown as IRSymbol] })

    // Which of the three is quoted is the spec's field order, not this test's business.
    expect(error.message).toMatch(/"(source|calls|rules)" is absent/)
    expect(error.message).toContain("2 more")
    // A count is enough to know how much is left and not enough to act on. `violations`
    // carries every breach, so a caller repairing a hand-assembled Document does not run the
    // diff once per field to find the next one.
    expect(error.violations?.map((v) => v.subject)).toEqual([
      "headIR.symbols[0]",
      "headIR.symbols[0]",
      "headIR.symbols[0]",
    ])
    expect(error.violations?.map((v) => v.message).join(" ")).toMatch(/"source"/)
    expect(error.violations?.every((v) => v.invariant === 20)).toBe(true)
  })

  it("puts the side on every violation, not only on the one the message quotes", () => {
    const symbol = { ...makeSymbol({ id: "ts:src/a.ts#f", name: "f" }) } as Record<string, unknown>
    delete symbol.source
    const error = caught(makeIR({ symbols: [symbol as unknown as IRSymbol] }), makeIR())

    // `checkDocumentShape` writes `symbols[0]`; which document that is comes from here, and
    // an array a caller reads without the message is where it matters most.
    expect(error.violations?.[0]?.subject).toBe("baseIR.symbols[0]")
  })
})

describe("the Document's own records are gated too, not just the collections", () => {
  it("refuses a minimal hand-assembled IR carrying only the three collections", () => {
    // The shape someone reaches for after their first crash: `$schema` plus the arrays the
    // matcher reads. It is not an `aburi.ir.v1` Document, and `dependencySideView` reads
    // `stats.skippedFiles` off every side unconditionally.
    const minimal = {
      $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
      symbols: [],
      components: [],
      dependencies: [],
    } as unknown as IR
    const error = caught(minimal, minimal)

    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toContain("baseIR:")
    expect(error.violations?.map((v) => v.message).join(" ")).toMatch(
      /"generator".*"workspace".*"stats"/s,
    )
  })

  it.each([
    "stats",
    "generator",
    "workspace",
  ])("refuses a Document missing %s, with no index to name", (field) => {
    const { base, head } = changedPair()
    const broken = { ...head } as Record<string, unknown>
    delete broken[field]
    const error = caught(base, broken as unknown as IR)

    // A top-level breach has no collection and no index, so the subject is the side alone
    // — `headIR: "stats" is absent`, not `headIR.document: …`.
    expect(error.message).toBe(`headIR: "${field}" is absent, not an object.`)
  })

  it("names a nested record by the path to it", () => {
    const { base, head } = changedPair()
    const stats = { ...head.stats, effectPropagation: { sccCount: 0 } }
    const error = caught(base, { ...head, stats } as unknown as IR)

    // The only path that exercises stripping the `document.` prefix out of the middle of a
    // subject rather than off the whole of it.
    expect(error.message).toContain("headIR.stats.effectPropagation:")
    expect(error.message).not.toContain("document")
  })

  it("refuses an empty $schema in the gate's own wording", () => {
    const { base, head } = changedPair()
    const error = caught({ ...base, $schema: "" } as unknown as IR, head)

    // Two Documents that both say "" agree with each other, so `schema-mismatch` never fires
    // on the pair. One code, one message shape.
    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toBe(`baseIR: "$schema" is empty, not a schema URL.`)
  })
})

describe("a Symbol with no id is the caller's fault, and says so", () => {
  it("is an ir-shape-invalid, never a slice-invariant-violated", () => {
    const symbol = { ...makeSymbol({ id: "ts:src/a.ts#f", name: "f" }) } as Record<string, unknown>
    delete symbol.id
    const error = caught(makeIR({ symbols: [symbol as unknown as IRSymbol] }), makeIR())

    // `slice-invariant-violated` means Aburi produced a bad Slice, and the CLI prints it as
    // "a bug in Aburi, not in your configuration". A Slice derived from a caller's malformed
    // Symbol is not that. The identity scan already closed this path; the gate now closes it
    // one step earlier, and this pins that neither reopens.
    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toContain("symbols[0]")
  })
})

describe("the gate is invariant #20, not the whole checker", () => {
  it("diffs an IR whose symbols[] is out of sort order", () => {
    // Array ordering is a semantic invariant the CLI enforces on a Document read off disk.
    // The diff's answer does not depend on it — stage 1 keys by id — so refusing this input
    // would withhold an answer the matcher can give.
    const z = makeSymbol({ id: "ts:src/z.ts#f", name: "z" })
    const a = makeSymbol({ id: "ts:src/a.ts#f", name: "a" })
    const unsorted = makeIR({ symbols: [z, a] })

    expect(() => diffOf(unsorted, unsorted)).not.toThrow()
  })

  it("leaves a well-formed pair untouched", () => {
    const { base, head } = changedPair()
    const result = diffOf(base, head)

    expect(result.summary.changed).toBe(1)
  })
})
