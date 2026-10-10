import { component, dependency, makeIR, makeSymbol } from "@aburi/test-support"
import type { SkipReason } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, writeCanonicalDiff } from "../src"

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
    expect(result.$schema).toBe("https://aburi.kage1020.com/schema/aburi.diff.v1.json")
    expect(result.summary.added).toBe(0)
    expect(result.summary.unchanged).toBe(0)
  })

  it("serialises unknown edges byte-identically however the inputs are ordered", () => {
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

  it("serialises notCompared byte-identically across renames, however anything is ordered", () => {
    const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
    const baseLosses = [
      { path: "src/a.ts", reason: "over-size" as const },
      { path: "src/y.ts", reason: "parse-failed" as const },
      { path: "src/z.ts", reason: "parse-timeout" as const },
    ]
    const headLosses = [
      { path: "src/z.ts", reason: "over-size" as const },
      { path: "src/b.ts", reason: "parse-failed" as const },
    ]
    const renames: [string, string][] = [
      ["src/a.ts", "src/z.ts"],
      ["src/y.ts", "src/b.ts"],
    ]
    const withLosses = (skippedFiles: readonly { path: string; reason: SkipReason }[]) =>
      makeIR({
        symbols: [kept],
        stats: {
          totalFiles: 4,
          parsedFiles: 4 - skippedFiles.length,
          keptSymbols: 1,
          droppedSymbols: 0,
          effectPropagation: {
            sccCount: 0,
            maxSccSize: 0,
            propagatedEffectCount: 0,
            symbolsWithPropagatedEffects: 0,
          },
          skippedFiles: [...skippedFiles],
        },
      })
    const forward = buildDiff({
      baseIR: withLosses(baseLosses),
      headIR: withLosses(headLosses),
      base: IR_REF,
      head: IR_REF,
      gitRenames: new Map(renames),
    })
    const reversed = buildDiff({
      baseIR: withLosses([...baseLosses].reverse()),
      headIR: withLosses([...headLosses].reverse()),
      base: IR_REF,
      head: IR_REF,
      gitRenames: new Map([...renames].reverse()),
    })
    expect(forward.notCompared.map((file) => [file.path, file.basePath ?? null])).toEqual([
      ["src/b.ts", "src/y.ts"],
      ["src/z.ts", "src/a.ts"],
      ["src/z.ts", null],
    ])
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
