import { rule } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  apiFingerprint,
  type ComputeFingerprintInput,
  CoreError,
  computeSymbolFingerprint,
  logicFingerprint,
  syntaxFingerprint,
  ZERO_FINGERPRINT,
} from "../../src/index"
import { makeSymbol } from "../fixtures/ir"

describe("computeSymbolFingerprint", () => {
  const symbol = makeSymbol("ts:src/a.ts#foo", {
    rules: [rule({ type: "guard", line: 3, condition: "x > 0" })],
  })

  it("computes each axis with its own hasher", () => {
    expect(computeSymbolFingerprint({ symbol, normalizedAstString: "(x)" })).toEqual({
      api: apiFingerprint(symbol),
      logic: logicFingerprint(symbol),
      syntax: syntaxFingerprint("(x)"),
    })
  })

  it("gives a dropped Symbol zero on every axis, without needing an AST string", () => {
    const dropped = makeSymbol(symbol.id, { ...symbol, dropped: true, dropReason: "pure DTO" })
    expect(computeSymbolFingerprint({ symbol: dropped })).toEqual({
      api: ZERO_FINGERPRINT,
      logic: ZERO_FINGERPRINT,
      syntax: ZERO_FINGERPRINT,
    })
  })

  it.each<[string, ComputeFingerprintInput]>([
    ["no", { symbol }],
    ["a whitespace-only", { symbol, normalizedAstString: "   " }],
  ])("refuses %s AST string for a kept Symbol, so AST-less Symbols cannot share a hash", (_what, input) => {
    expect(() => computeSymbolFingerprint(input)).toThrow(CoreError)
  })
})
