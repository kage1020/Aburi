import type { ImportEdge, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { resolveCallGraph } from "../src/callgraph"
import { importsOf, withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

const NO_IMPORTS: ReadonlyMap<string, readonly ImportEdge[]> = new Map()

describe("a dotted call target reaches the member Symbol it names", () => {
  it.each<[string, IRSymbol[], ReadonlyMap<string, readonly ImportEdge[]>, string]>([
    [
      "the caller's file",
      [
        makeSymbol("ts:src/a.ts#Cls", { kind: "class" }),
        makeSymbol("ts:src/a.ts#Cls.method", { kind: "method" }),
      ],
      NO_IMPORTS,
      "ts:src/a.ts#Cls.method",
    ],
    [
      "the file its receiver is imported from",
      [
        makeSymbol("ts:src/x.ts#Cls", { kind: "class" }),
        makeSymbol("ts:src/x.ts#Cls.method", { kind: "method" }),
      ],
      importsOf("src/a.ts", { source: "./x", symbols: ["Cls"] }),
      "ts:src/x.ts#Cls.method",
    ],
  ])("resolves `Cls.method` declared in %s", (_where, callees, importsByFile, to) => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Cls.method", line: 7 }])
    const result = resolveCallGraph({ symbols: [caller, ...callees], importsByFile })
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([[to, "high"]])
  })

  it("reaches the static member through a class name, not the instance one", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "C.m", line: 3 }])
    const result = resolveCallGraph({
      symbols: [
        caller,
        makeSymbol("ts:src/a.ts#C", { kind: "class" }),
        makeSymbol("ts:src/a.ts#C.m", { kind: "method" }),
        makeSymbol("ts:src/a.ts#C::m", { kind: "function" }),
      ],
      importsByFile: NO_IMPORTS,
    })
    expect(result.edges.map((edge) => edge.to)).toEqual(["ts:src/a.ts#C::m"])
  })

  it("reaches the static member over there through an imported class, named or in a namespace", () => {
    const caller = withCalls("ts:src/a.ts#caller", [
      { target: "C.m", line: 5 },
      { target: "ns.C.m", line: 6 },
    ])
    const result = resolveCallGraph({
      symbols: [
        caller,
        makeSymbol("ts:src/x.ts#C", { kind: "class" }),
        makeSymbol("ts:src/x.ts#C.m", { kind: "method" }),
        makeSymbol("ts:src/x.ts#C::m", { kind: "method" }),
      ],
      importsByFile: importsOf(
        "src/a.ts",
        { source: "./x", symbols: ["C"] },
        { source: "./x", symbols: "*", namespaceBinding: "ns" },
      ),
    })
    expect(result.edges.map((edge) => [edge.to, edge.line])).toEqual([
      ["ts:src/x.ts#C::m", 5],
      ["ts:src/x.ts#C::m", 6],
    ])
  })

  it("joins with `::` only where a static member is declared", () => {
    const caller = withCalls("ts:src/a.ts#caller", [
      { target: "C.Inner.g", line: 3 },
      { target: "C.K.s", line: 4 },
    ])
    const result = resolveCallGraph({
      symbols: [
        caller,
        makeSymbol("ts:src/a.ts#C", { kind: "class" }),
        makeSymbol("ts:src/a.ts#C::Inner", { kind: "namespace" }),
        makeSymbol("ts:src/a.ts#C::Inner.g", { kind: "function" }),
        makeSymbol("ts:src/a.ts#C::K", { kind: "class" }),
        makeSymbol("ts:src/a.ts#C::K::s", { kind: "method" }),
      ],
      importsByFile: NO_IMPORTS,
    })
    expect(result.edges.map((edge) => edge.to)).toEqual([
      "ts:src/a.ts#C::Inner.g",
      "ts:src/a.ts#C::K::s",
    ])
  })

  it.each([
    ["is not declared", "Cls.absent"],
    ["cannot be spelled as a Symbol id", "Cls.not an identifier"],
  ])("leaves a call unresolved, without failing, when the member %s", (_why, target) => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target, line: 3 }])
    const cls = makeSymbol("ts:src/a.ts#Cls", { kind: "class" })
    const result = resolveCallGraph({ symbols: [caller, cls], importsByFile: NO_IMPORTS })
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => [d.target, d.bucket])).toEqual([[target, "no-match"]])
  })
})
