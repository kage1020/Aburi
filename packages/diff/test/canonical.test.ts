import { describe, expect, it } from "vitest"
import { buildDiff, writeCanonicalDiff } from "../src"
import { component, dependency, makeIR, makeSymbol } from "./fixtures"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

describe("writeCanonicalDiff — byte-deterministic output", () => {
  it("produces identical bytes for identical DiffResult inputs", () => {
    const s = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })
    const base = makeIR({ symbols: [s] })
    const head = makeIR({
      symbols: [s, makeSymbol({ id: "ts:src/a.ts#Bar", name: "Bar" })],
      components: [component({ id: "core", name: "core" })],
      dependencies: [dependency({ from: "core", to: "shared" })],
    })
    const d1 = buildDiff({ baseIR: base, headIR: head, base: IR_REF, head: IR_REF })
    const d2 = buildDiff({ baseIR: base, headIR: head, base: IR_REF, head: IR_REF })
    expect(writeCanonicalDiff(d1)).toBe(writeCanonicalDiff(d2))
  })

  it("carries the correct schema URL and shape", () => {
    const base = makeIR()
    const head = makeIR()
    const result = buildDiff({ baseIR: base, headIR: head, base: IR_REF, head: IR_REF })
    expect(result.$schema).toBe("https://aburi.dev/schema/aburi.diff.v1.json")
    expect(result.summary.added).toBe(0)
    expect(result.summary.unchanged).toBe(0)
  })

  it("serialises unknown edges byte-identically however the inputs are ordered", () => {
    // The array is built by walking two Maps, so without the explicit sort its order follows
    // insertion order and the same two revisions produce two different files.
    const gone = makeSymbol({ id: "ts:src/gone.ts#gone", name: "gone" })
    const also = makeSymbol({ id: "ts:src/also.ts#also", name: "also" })
    const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
    const edges = [
      dependency({ from: "ts:src/kept.ts#kept", to: "ts:src/gone.ts#gone", via: "call" }),
      dependency({ from: "ts:src/also.ts#also", to: "ts:src/kept.ts#kept", via: "call" }),
    ]
    const head = makeIR({
      symbols: [kept],
      stats: {
        totalFiles: 3,
        parsedFiles: 1,
        keptSymbols: 1,
        droppedSymbols: 0,
        effectPropagation: {
          sccCount: 0,
          maxSccSize: 0,
          propagatedEffectCount: 0,
          symbolsWithPropagatedEffects: 0,
        },
        skippedFiles: [
          { path: "src/also.ts", reason: "parse-failed" },
          { path: "src/gone.ts", reason: "parse-failed" },
        ],
      },
    })
    const forward = buildDiff({
      baseIR: makeIR({ symbols: [gone, also, kept], dependencies: edges }),
      headIR: head,
      base: IR_REF,
      head: IR_REF,
    })
    const reversed = buildDiff({
      baseIR: makeIR({ symbols: [kept, also, gone], dependencies: [...edges].reverse() }),
      headIR: head,
      base: IR_REF,
      head: IR_REF,
    })
    expect(forward.dependencies.unknown).toHaveLength(2)
    expect(writeCanonicalDiff(forward)).toBe(writeCanonicalDiff(reversed))
  })

  it("writes the empty notCompared array rather than dropping the key", () => {
    // The reason the key is emitted at all: a reader must be able to tell "the comparison
    // covered everything" from "this writer predates the field", and only the bytes on disk
    // can carry that. A serialiser that pruned empty arrays would leave every unit test green
    // and take the distinction with it.
    const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
    const clean = buildDiff({
      baseIR: makeIR({ symbols: [kept] }),
      headIR: makeIR({ symbols: [kept] }),
      base: IR_REF,
      head: IR_REF,
    })
    expect(clean.notCompared).toEqual([])
    expect(writeCanonicalDiff(clean)).toContain('"notCompared": []')
  })

  it("serialises notCompared byte-identically however the skip lists are ordered", () => {
    // Same hazard as the unknown edges above: the array is built by walking a Map, so without
    // the explicit sort its order follows whatever order the two scans happened to record
    // their losses in, and one workspace produces two different files.
    const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
    const losses = [
      { path: "z/last.ts", reason: "over-size" as const },
      { path: "a/first.ts", reason: "parse-failed" as const },
    ]
    const withLosses = (skippedFiles: typeof losses) =>
      makeIR({
        symbols: [kept],
        stats: {
          totalFiles: 3,
          parsedFiles: 1,
          keptSymbols: 1,
          droppedSymbols: 0,
          effectPropagation: {
            sccCount: 0,
            maxSccSize: 0,
            propagatedEffectCount: 0,
            symbolsWithPropagatedEffects: 0,
          },
          skippedFiles,
        },
      })
    const forward = buildDiff({
      baseIR: withLosses(losses),
      headIR: withLosses(losses),
      base: IR_REF,
      head: IR_REF,
    })
    const reversed = buildDiff({
      baseIR: withLosses([...losses].reverse()),
      headIR: withLosses([...losses].reverse()),
      base: IR_REF,
      head: IR_REF,
    })
    expect(forward.notCompared).toHaveLength(2)
    expect(writeCanonicalDiff(forward)).toBe(writeCanonicalDiff(reversed))
  })

  it("sorts symbols[] by (status, reference-id) so ordering is stable", () => {
    const s1 = makeSymbol({ id: "ts:src/a.ts#Bar", name: "Bar" })
    const s2 = makeSymbol({ id: "ts:src/a.ts#Alpha", name: "Alpha" })
    const base = makeIR()
    const head = makeIR({ symbols: [s1, s2] })
    const result = buildDiff({ baseIR: base, headIR: head, base: IR_REF, head: IR_REF })
    const idsInOrder = result.symbols.map((c) =>
      c.status === "added" || c.status === "removed" || c.status === "unknown"
        ? c.symbol.id
        : c.after.id,
    )
    expect(idsInOrder).toEqual([...idsInOrder].sort())
  })
})
