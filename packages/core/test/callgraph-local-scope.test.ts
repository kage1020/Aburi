import { sig } from "@aburi/test-support"
import type { ImportEdge, Symbol as IRSymbol, Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { resolveCallGraph } from "../src/callgraph"
import { importsOf, params } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

const NO_IMPORTS: ReadonlyMap<string, readonly ImportEdge[]> = new Map()

describe("a caller's parameter shadows the Symbols its name would reach", () => {
  it.each<[string, string, IRSymbol[], ReadonlyMap<string, readonly ImportEdge[]>]>([
    ["in the caller's file", "helper", [makeSymbol("ts:src/a.ts#helper")], NO_IMPORTS],
    [
      "as a member in the caller's file",
      "helper.method",
      [
        makeSymbol("ts:src/a.ts#helper", { kind: "class" }),
        makeSymbol("ts:src/a.ts#helper.method", { kind: "method" }),
      ],
      NO_IMPORTS,
    ],
    [
      "through an import",
      "helper",
      [makeSymbol("ts:src/util.ts#helper")],
      importsOf("src/a.ts", { source: "./util", symbols: ["helper"] }),
    ],
    [
      "in the caller's component and the workspace",
      "helper.method",
      [
        makeSymbol("ts:src/x.ts#helper.method", { kind: "method", component: "billing" }),
        makeSymbol("ts:src/y.ts#helper.method", { kind: "method", component: "reporting" }),
      ],
      NO_IMPORTS,
    ],
  ])("leaves the call unresolved, bucketed `local-scope`, over a Symbol %s", (_where, target, callees, importsByFile) => {
    const caller = makeSymbol("ts:src/a.ts#caller", {
      component: "billing",
      signature: params("helper"),
      calls: [{ target, line: 5, resolved: null }],
    })
    const result = resolveCallGraph({ symbols: [caller, ...callees], importsByFile })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["local-scope"])
  })

  describe("a destructuring parameter shadows the names it binds", () => {
    function resolvedTargets(inputs: Signature["inputs"], targets: readonly string[]) {
      const caller = makeSymbol("ts:src/a.ts#caller", {
        signature: sig({ inputs, outputs: [] }),
        calls: targets.map((target, index) => ({ target, line: 5 + index, resolved: null })),
      })
      const result = resolveCallGraph({
        symbols: [caller, makeSymbol("ts:src/a.ts#save"), makeSymbol("ts:src/a.ts#fallback")],
        importsByFile: NO_IMPORTS,
      })
      return result.symbols[0]?.calls.map((call) => call.resolved)
    }

    it.each<[string, Signature["inputs"][number]]>([
      ["{ save }", { name: "{ save }", type: "Deps", bindings: ["save"] }],
      ["[save]", { name: "[save]", type: "Deps", bindings: ["save"] }],
      ["{ persist: save }", { name: "{ persist: save }", type: "Deps", bindings: ["save"] }],
      ["{ save = fallback }", { name: "{ save = fallback }", type: "Deps", bindings: ["save"] }],
      ["...save", { name: "save", type: "Deps[]", rest: true }],
      ["...[save]", { name: "[save]", type: "Deps", rest: true, bindings: ["save"] }],
      ["...{ save }", { name: "{ save }", type: "Deps", rest: true, bindings: ["save"] }],
    ])("`%s`", (_written, input) => {
      expect(resolvedTargets([input], ["save", "save.call"])).toEqual([null, null])
    })

    it("does not shadow a name the pattern only reads (`{ a = fallback }` reads `fallback`)", () => {
      const input = { name: "{ a = fallback }", type: "", bindings: ["a"] }
      expect(resolvedTargets([input], ["fallback"])).toEqual(["ts:src/a.ts#fallback"])
    })

    it("reads the bindings of a pattern that follows a single-name parameter", () => {
      const inputs = [
        { name: "cb", type: "" },
        { name: "{ save }", type: "Deps", bindings: ["save"] },
      ]
      expect(resolvedTargets(inputs, ["save"])).toEqual([null])
    })
  })
})
