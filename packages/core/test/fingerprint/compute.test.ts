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
    const fp = computeSymbolFingerprint(symbol, { normalizedAstString: "(x)" })
    expect(fp.api).toBe(apiFingerprint(symbol))
    expect(fp.logic).toBe(logicFingerprint(symbol))
    expect(fp.syntax).toBe(syntaxFingerprint("(x)"))
  })

  it("D1: a dropped Symbol receives ZERO on every axis", () => {
    const dropped = makeSymbol(symbol.id, {
      ...symbol,
      dropped: true,
      dropReason: "pure DTO",
    })
    const fp = computeSymbolFingerprint(dropped, { normalizedAstString: "(anything)" })
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
    const droppedFp = computeSymbolFingerprint(dropped, { normalizedAstString: "(x)" })
    const keptFp = computeSymbolFingerprint(kept, { normalizedAstString: "(x)" })
    expect(droppedFp.api).not.toBe(keptFp.api)
    expect(droppedFp.api).toBe(ZERO_FINGERPRINT)
  })

  it("uses the empty string for syntax when normalizedAstString is omitted", () => {
    const fp = computeSymbolFingerprint(symbol)
    expect(fp.syntax).toBe(syntaxFingerprint(""))
  })
})
