import { describe, expect, it } from "vitest"
import { buildDiff, computeSymbolDelta, DiffError, MAX_LINE_FUZZ, MIN_LINE_FUZZ } from "../src"
import { makeIR, makeSymbol } from "./fixtures"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

describe("DiffError — invalid-line-fuzz", () => {
  const base = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })
  const head = makeSymbol({
    ...base,
    fingerprint: { ...base.fingerprint, syntax: "syn-changed" },
  })

  it("throws when lineFuzz is below the minimum", () => {
    expect(() => computeSymbolDelta(base, head, { lineFuzz: -1 })).toThrow(
      /within \[0, 10\]; got -1/,
    )
    try {
      computeSymbolDelta(base, head, { lineFuzz: -1 })
    } catch (e) {
      expect(e).toBeInstanceOf(DiffError)
      if (e instanceof DiffError) {
        expect(e.code).toBe("invalid-line-fuzz")
        expect(e.value).toBe("-1")
      }
    }
  })

  it("throws when lineFuzz is above the maximum", () => {
    expect(() => computeSymbolDelta(base, head, { lineFuzz: MAX_LINE_FUZZ + 1 })).toThrow(DiffError)
  })

  it("throws on NaN / Infinity — silent normalisation would hide upstream bugs", () => {
    expect(() => computeSymbolDelta(base, head, { lineFuzz: Number.NaN })).toThrow(
      /must be an integer/,
    )
    expect(() => computeSymbolDelta(base, head, { lineFuzz: Number.POSITIVE_INFINITY })).toThrow(
      DiffError,
    )
  })

  it("throws on fractional values (contract says integer)", () => {
    expect(() => computeSymbolDelta(base, head, { lineFuzz: 1.5 })).toThrow(/must be an integer/)
  })

  it("accepts the min and max boundary values", () => {
    expect(() => computeSymbolDelta(base, head, { lineFuzz: MIN_LINE_FUZZ })).not.toThrow()
    expect(() => computeSymbolDelta(base, head, { lineFuzz: MAX_LINE_FUZZ })).not.toThrow()
  })

  it("propagates through buildDiff when delta.lineFuzz is invalid", () => {
    const ir = makeIR({ symbols: [base] })
    const modifiedHead = makeIR({ symbols: [head] })
    expect(() =>
      buildDiff({
        baseIR: ir,
        headIR: modifiedHead,
        base: IR_REF,
        head: IR_REF,
        delta: { lineFuzz: 999 },
      }),
    ).toThrow(DiffError)
  })
})

describe("DiffError — ir-shape-invalid", () => {
  const validIR = makeIR()

  it("throws when a required collection is not an array", () => {
    const brokenBase = { ...validIR, symbols: undefined } as unknown as typeof validIR
    expect(() =>
      buildDiff({
        baseIR: brokenBase,
        headIR: validIR,
        base: IR_REF,
        head: IR_REF,
      }),
    ).toThrow(/baseIR.symbols must be an array/)
  })

  it("throws when components is missing", () => {
    const brokenHead = { ...validIR, components: undefined } as unknown as typeof validIR
    expect(() =>
      buildDiff({
        baseIR: validIR,
        headIR: brokenHead,
        base: IR_REF,
        head: IR_REF,
      }),
    ).toThrow(/headIR.components must be an array/)
  })

  it("throws when dependencies is missing", () => {
    const brokenHead = { ...validIR, dependencies: null } as unknown as typeof validIR
    expect(() =>
      buildDiff({
        baseIR: validIR,
        headIR: brokenHead,
        base: IR_REF,
        head: IR_REF,
      }),
    ).toThrow(/headIR.dependencies must be an array/)
  })

  it("throws when $schema is empty", () => {
    const brokenBase = { ...validIR, $schema: "" } as unknown as typeof validIR
    expect(() =>
      buildDiff({
        baseIR: brokenBase,
        headIR: validIR,
        base: IR_REF,
        head: IR_REF,
      }),
    ).toThrow(/\$schema must be a non-empty schema URL/)
  })

  it("throws when the IR argument is not an object", () => {
    expect(() =>
      buildDiff({
        baseIR: null as unknown as typeof validIR,
        headIR: validIR,
        base: IR_REF,
        head: IR_REF,
      }),
    ).toThrow(/baseIR must be an IR object/)
  })
})
