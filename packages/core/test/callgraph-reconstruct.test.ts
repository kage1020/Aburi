import { makeIR } from "@aburi/test-support"
import type { Confidence, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { reconstructCallEdgesFromIR } from "../src/callgraph"
import { makeSymbol } from "./fixtures/ir"

describe("reconstructCallEdgesFromIR", () => {
  it.each<[string, IRSymbol[]]>([
    ["no symbols", []],
    ["symbols with empty calls[]", [makeSymbol("ts:src/a.ts#a"), makeSymbol("ts:src/a.ts#b")]],
    [
      "only unresolved calls",
      [
        makeSymbol("ts:src/a.ts#caller", {
          calls: [{ target: "unknown", line: 3, resolved: null }],
        }),
      ],
    ],
  ])("returns [] for an IR with %s", (_label, symbols) => {
    expect(reconstructCallEdgesFromIR(makeIR({ symbols }))).toEqual([])
  })

  it.each<Confidence>([
    "high",
    "low",
  ])("emits one edge per resolved call in the CallEdge shape, at the caller's %s confidence", (confidence) => {
    const ir = makeIR({
      symbols: [
        makeSymbol("ts:src/a.ts#caller", {
          confidence,
          calls: [{ target: "helper", line: 5, resolved: "ts:src/a.ts#helper" }],
        }),
        makeSymbol("ts:src/a.ts#helper"),
      ],
    })
    expect(reconstructCallEdgesFromIR(ir)).toEqual([
      { from: "ts:src/a.ts#caller", to: "ts:src/a.ts#helper", via: "call", confidence, line: 5 },
    ])
  })

  it("emits one edge per call site when the same caller invokes the same callee on several lines", () => {
    const ir = makeIR({
      symbols: [
        makeSymbol("ts:src/a.ts#caller", {
          calls: [
            { target: "helper", line: 3, resolved: "ts:src/a.ts#helper" },
            { target: "helper", line: 7, resolved: "ts:src/a.ts#helper" },
          ],
        }),
        makeSymbol("ts:src/a.ts#helper"),
      ],
    })
    expect(reconstructCallEdgesFromIR(ir).map((e) => e.line)).toEqual([3, 7])
  })

  it("sorts edges by (from, to, line), the order resolveCallGraph returns them in", () => {
    const ir = makeIR({
      symbols: [
        makeSymbol("ts:src/z.ts#z", {
          calls: [{ target: "b", line: 4, resolved: "ts:src/b.ts#b" }],
        }),
        makeSymbol("ts:src/a.ts#a", {
          calls: [
            { target: "c", line: 2, resolved: "ts:src/c.ts#c" },
            { target: "b", line: 1, resolved: "ts:src/b.ts#b" },
          ],
        }),
        makeSymbol("ts:src/b.ts#b"),
        makeSymbol("ts:src/c.ts#c"),
      ],
    })
    expect(reconstructCallEdgesFromIR(ir).map((e) => `${e.from}->${e.to}@${e.line}`)).toEqual([
      "ts:src/a.ts#a->ts:src/b.ts#b@1",
      "ts:src/a.ts#a->ts:src/c.ts#c@2",
      "ts:src/z.ts#z->ts:src/b.ts#b@4",
    ])
  })
})
