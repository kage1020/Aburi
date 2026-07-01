import { describe, expect, it } from "vitest"
import {
  apiFingerprint,
  computeSymbolFingerprint,
  logicFingerprint,
  syntaxFingerprint,
  ZERO_FINGERPRINT,
} from "../../src/index"
import { makeSymbol } from "../fixtures/ir"

describe("computeSymbolFingerprint", () => {
  const symbol = makeSymbol("ts:src/a.ts#foo", {
    rules: [{ type: "guard", line: 3, condition: "x > 0", what: null, expr: null, loopKind: null }],
  })

  it("delegates each axis to the axis-specific hasher", () => {
    const fp = computeSymbolFingerprint({ symbol, normalizedAstString: "(x)" })
    expect(fp.api).toBe(apiFingerprint(symbol))
    expect(fp.logic).toBe(logicFingerprint(symbol))
    expect(fp.syntax).toBe(syntaxFingerprint("(x)"))
  })

  it("100x determinism: repeated calls never diverge on any axis", () => {
    const first = computeSymbolFingerprint({ symbol, normalizedAstString: "(x)" })
    for (let i = 0; i < 100; i++) {
      const fp = computeSymbolFingerprint({ symbol, normalizedAstString: "(x)" })
      expect(fp).toEqual(first)
    }
  })

  it("D1: a dropped Symbol receives ZERO on every axis without needing an AST string", () => {
    const dropped = makeSymbol(symbol.id, {
      ...symbol,
      dropped: true,
      dropReason: "pure DTO",
    })
    const fp = computeSymbolFingerprint({ symbol: dropped })
    expect(fp).toEqual({
      api: ZERO_FINGERPRINT,
      logic: ZERO_FINGERPRINT,
      syntax: ZERO_FINGERPRINT,
    })
  })

  it("D2: dropped=true and dropped=false produce different fingerprints for the same shape", () => {
    const dropped = makeSymbol(symbol.id, {
      ...symbol,
      dropped: true,
      dropReason: "logger boilerplate",
    })
    const kept = makeSymbol(symbol.id, { ...symbol, dropped: false })
    const droppedFp = computeSymbolFingerprint({ symbol: dropped })
    const keptFp = computeSymbolFingerprint({ symbol: kept, normalizedAstString: "(x)" })
    expect(droppedFp.api).not.toBe(keptFp.api)
    expect(droppedFp.api).toBe(ZERO_FINGERPRINT)
  })

  it("refuses whitespace-only normalizedAstString so missing-AST Symbols cannot collapse to the same hash", () => {
    const kept = makeSymbol(symbol.id, { ...symbol, dropped: false })
    expect(() =>
      computeSymbolFingerprint({ symbol: kept, normalizedAstString: "   \n\t " }),
    ).toThrowError(/empty normalized AST/)
  })
})
