import { component, decorator, dependency, effect, makeIR, rule } from "@aburi/test-support"
import type { Effect, IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkIRIntegrity } from "../src/index"
import { makeSymbol, type SymbolOverrides } from "./fixtures/ir"

const FOO = "ts:src/a.ts#foo"

function orderViolations(ir: IR) {
  return checkIRIntegrity(ir).filter((v) => v.invariant === 11)
}

function withSymbol(overrides: SymbolOverrides): IR {
  return makeIR({ symbols: [makeSymbol(FOO, overrides)] })
}

function localEffect(target: string, line: number): Effect {
  return effect({ id: "db.write", target, plugin: "p", line })
}

function propagatedEffect(id: string, target: string): Effect {
  return effect({ id, target, plugin: "p", propagated: true, derivedFrom: ["ts:src/b.ts#callee"] })
}

describe("checkIRIntegrity — ordering", () => {
  it.each<[string, () => IR, string]>([
    [
      "components[] by id",
      () =>
        makeIR({
          components: [component({ id: "b", name: "b" }), component({ id: "a", name: "a" })],
        }),
      "components[]",
    ],
    [
      "symbols[] by id",
      () => makeIR({ symbols: [makeSymbol("ts:src/a.ts#z"), makeSymbol("ts:src/a.ts#a")] }),
      "symbols[]",
    ],
    [
      "dependencies[] by (from, to, via)",
      () =>
        makeIR({
          dependencies: [dependency({ from: "b", to: "a" }), dependency({ from: "a", to: "b" })],
        }),
      "dependencies[]",
    ],
    [
      "a Symbol's decorators by line",
      () =>
        withSymbol({
          decorators: [decorator({ name: "B", line: 10 }), decorator({ name: "A", line: 5 })],
        }),
      `symbols[id=${FOO}].decorators[].line`,
    ],
    [
      "a Symbol's rules by line",
      () =>
        withSymbol({ rules: [rule({ type: "guard", line: 5 }), rule({ type: "throw", line: 2 })] }),
      `symbols[id=${FOO}].rules[].line`,
    ],
    [
      "a Symbol's calls by line",
      () =>
        withSymbol({
          calls: [
            { target: "b", line: 5, resolved: null },
            { target: "a", line: 2, resolved: null },
          ],
        }),
      `symbols[id=${FOO}].calls[].line`,
    ],
    [
      "a Symbol's locally-detected effects by line",
      () => withSymbol({ effects: [localEffect("x", 5), localEffect("y", 2)] }),
      `symbols[id=${FOO}].effects[]/local.line`,
    ],
    [
      "a Symbol's propagated effects by (id, target)",
      () =>
        withSymbol({
          effects: [propagatedEffect("db.write", "b"), propagatedEffect("db.write", "a")],
        }),
      `symbols[id=${FOO}].effects[]/propagated(id,target)`,
    ],
  ])("reports %s out of order", (_what, build, subject) => {
    expect(orderViolations(build()).map((v) => v.subject)).toEqual([subject])
  })

  it("names the first pair out of order, by value or by line", () => {
    const byId = makeIR({ symbols: [makeSymbol("ts:src/a.ts#z"), makeSymbol("ts:src/a.ts#a")] })
    expect(orderViolations(byId)[0]?.message).toBe(
      'symbols[] not sorted: "ts:src/a.ts#z" precedes "ts:src/a.ts#a"',
    )
    const byLine = withSymbol({
      rules: [rule({ type: "guard", line: 5 }), rule({ type: "throw", line: 2 })],
    })
    expect(orderViolations(byLine)[0]?.message).toContain("line 5 precedes 2")
  })

  it("reports a collection once, however many of its pairs are out of order", () => {
    const ir = makeIR({
      symbols: [
        makeSymbol("ts:src/a.ts#c"),
        makeSymbol("ts:src/a.ts#b"),
        makeSymbol("ts:src/a.ts#a"),
      ],
    })
    expect(orderViolations(ir)).toHaveLength(1)
  })

  it("accepts every collection in order, ties included", () => {
    const ir = withSymbol({
      decorators: [decorator({ name: "B", line: 5 }), decorator({ name: "A", line: 5 })],
      rules: [rule({ type: "guard", line: 2 }), rule({ type: "throw", line: 2 })],
      calls: [
        { target: "b", line: 3, resolved: null },
        { target: "a", line: 3, resolved: null },
      ],
      effects: [
        localEffect("z", 4),
        localEffect("y", 4),
        propagatedEffect("db.read", "z"),
        propagatedEffect("db.write", "a"),
      ],
    })
    expect(checkIRIntegrity(ir)).toEqual([])
  })
})

describe("checkIRIntegrity — effect segmentation", () => {
  const missingLine = localEffect("y", 1)
  delete missingLine.line

  it.each<[string, Effect[], string]>([
    [
      "a locally-detected effect after a propagated one",
      [propagatedEffect("db.write", "x"), localEffect("y", 5)],
      "locally-detected entry appears after a propagated entry (db.write/y)",
    ],
    [
      "a propagated effect that carries a line",
      [{ ...propagatedEffect("db.write", "x"), line: 3 }],
      "propagated entry (db.write/x) carries line=3",
    ],
    [
      "a propagated effect without derivedFrom",
      [effect({ id: "db.write", target: "x", plugin: "p", propagated: true })],
      "propagated entry (db.write/x) missing non-empty derivedFrom",
    ],
    [
      "a propagated effect with an empty derivedFrom",
      [{ ...propagatedEffect("db.write", "x"), derivedFrom: [] }],
      "propagated entry (db.write/x) missing non-empty derivedFrom",
    ],
    [
      "a locally-detected effect without a line",
      [missingLine],
      "locally-detected entry (db.write/y) missing line",
    ],
  ])("reports %s", (_what, effects, message) => {
    const violations = orderViolations(withSymbol({ effects }))
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain(message)
  })
})
