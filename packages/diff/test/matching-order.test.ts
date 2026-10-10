import { makeIR } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  matchStageDroppedWeak,
  matchStageLogicFingerprint,
  matchStageNameSignature,
  writeCanonicalDiff,
} from "../src"
import { diffOf, dropped, method } from "./helpers"

const ids = (symbols: readonly IRSymbol[]) => symbols.map((symbol) => symbol.id)

describe("every stage hands on what it did not claim, in the caller's order", () => {
  const symbols = [
    method("src/z.ts", "Svc.zeta", "z"),
    method("src/a.ts", "Svc.alpha", "a"),
    method("src/m.ts", "Svc.mu", "m"),
  ]

  it("stage 3, with nothing to pair", () => {
    const heads = [method("src/q.ts", "Svc.qoppa", "q")]
    const result = matchStageLogicFingerprint(symbols, heads)
    expect(result.remainingBase).toEqual(symbols)
    expect(result.remainingHead).toEqual(heads)
  })

  it("stage 3, around what it paired", () => {
    const result = matchStageLogicFingerprint(symbols, [method("src/n.ts", "Svc.mu", "m")])
    expect(result.matched).toHaveLength(1)
    expect(ids(result.remainingBase)).toEqual(["ts:src/z.ts#Svc.zeta", "ts:src/a.ts#Svc.alpha"])
  })

  it("stage 4, around what it paired", () => {
    const result = matchStageNameSignature(symbols, [method("src/n.ts", "Svc.alpha", "n")])
    expect(result.matched).toHaveLength(1)
    expect(ids(result.remainingBase)).toEqual(["ts:src/z.ts#Svc.zeta", "ts:src/m.ts#Svc.mu"])
  })

  it("the dropped weak match, which leaves kept Symbols where they were", () => {
    const mixed = [
      method("src/z.ts", "Svc.zeta", "z"),
      dropped("src/a/Dto.ts", "Svc.alpha"),
      dropped("src/b/Other.ts", "Svc.beta"),
      method("src/m.ts", "Svc.mu", "m"),
    ]
    const result = matchStageDroppedWeak(mixed, [dropped("src/c/Other.ts", "Svc.gamma")])
    expect(result.matched.map((pair) => pair.base.id)).toEqual(["ts:src/b/Other.ts#Svc.beta"])
    expect(ids(result.remainingBase)).toEqual([
      "ts:src/z.ts#Svc.zeta",
      "ts:src/a/Dto.ts#Svc.alpha",
      "ts:src/m.ts#Svc.mu",
    ])
  })
})

describe("the diff is a function of the two Documents, not of their array order", () => {
  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]]
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((tail) => [
        item,
        ...tail,
      ]),
    )
  }

  it("writes identical canonical bytes for every permutation of both sides", () => {
    const files = ["aaa", "mmm", "zzz"]
    const base = files.map((f) => method(`src/base/${f}.ts`, "Svc.createOrderRecord", `b${f}`))
    const head = files.map((f) => method(`src/head/${f}.ts`, "Svc.createOrderRecord", `h${f}`))
    const canonical = new Set<string>()
    for (const baseOrder of permutations(base)) {
      for (const headOrder of permutations(head)) {
        canonical.add(
          writeCanonicalDiff(
            diffOf(makeIR({ symbols: baseOrder }), makeIR({ symbols: headOrder })),
          ),
        )
      }
    }
    expect(canonical.size).toBe(1)
  })
})
