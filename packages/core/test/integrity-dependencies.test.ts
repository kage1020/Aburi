import { dependency, makeIR } from "@aburi/test-support"
import type { Dependency, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkIRIntegrity } from "../src/index"
import { makeSymbol } from "./fixtures/ir"

const CALLER = "ts:src/a.ts#caller"
const HELPER = "ts:src/a.ts#helper"

function callerResolvingTo(to: string): IRSymbol {
  return makeSymbol(CALLER, { calls: [{ target: "helper", line: 3, resolved: to }] })
}

function callEdge(from: string, to: string): Dependency {
  return dependency({ from, to, via: "call" })
}

describe("checkIRIntegrity — dependencies[]", () => {
  it("accepts a call edge projected from a resolved call between two declared Symbols", () => {
    const ir = makeIR({
      symbols: [callerResolvingTo(HELPER), makeSymbol(HELPER)],
      dependencies: [callEdge(CALLER, HELPER)],
    })
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it.each<[string, number, IRSymbol[], Dependency[]]>([
    [
      "an import whose Symbol-shaped endpoint names no declared Symbol",
      4,
      [makeSymbol("ts:src/a.ts#foo")],
      [dependency({ from: "ts:src/a.ts#foo", to: "ts:src/b.ts#missing", via: "import" })],
    ],
    [
      "a malformed Symbol-shaped endpoint, rather than passing it as a Component id",
      4,
      [makeSymbol("ts:src/a.ts#foo")],
      [dependency({ from: "ts:src/a.ts#foo", to: "ts:src\\b.ts#bar", via: "import" })],
    ],
    [
      "a call edge from a Component",
      12,
      [makeSymbol("ts:src/a.ts#foo")],
      [callEdge("billing", "ts:src/a.ts#foo")],
    ],
    [
      "a call edge to an undeclared Symbol",
      12,
      [callerResolvingTo("ts:src/missing.ts#gone")],
      [callEdge(CALLER, "ts:src/missing.ts#gone")],
    ],
    [
      "a call edge to a dropped Symbol",
      12,
      [callerResolvingTo(HELPER), makeSymbol(HELPER, { dropped: true, dropReason: "test" })],
      [callEdge(CALLER, HELPER)],
    ],
    [
      "a (from, to, via) triple listed twice, whatever the direction and effect",
      13,
      [callerResolvingTo(HELPER), makeSymbol(HELPER)],
      [
        callEdge(CALLER, HELPER),
        { ...callEdge(CALLER, HELPER), direction: "inbound", effect: "db.write" },
      ],
    ],
    ["a resolved call with no call edge", 14, [callerResolvingTo(HELPER), makeSymbol(HELPER)], []],
    [
      "a call edge that no resolved call backs",
      14,
      [makeSymbol(CALLER), makeSymbol(HELPER)],
      [callEdge(CALLER, HELPER)],
    ],
  ])("flags %s under invariant %i", (_what, invariant, symbols, dependencies) => {
    const violations = checkIRIntegrity(makeIR({ symbols, dependencies }))
    expect(violations.filter((v) => v.invariant === invariant)).toHaveLength(1)
  })
})
