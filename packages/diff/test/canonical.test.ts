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
