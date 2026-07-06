import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { ProjectionInvariantError, ruleRow } from "../src"

/**
 * Rule row rendering (§5.6). Every per-type payload the schema treats as required
 * (guard→condition, throw→what, return→expr, loop→loopKind, switch/match→condition) must
 * be present. When it is not, ruleRow throws ProjectionInvariantError so an upstream
 * extractor bug does not surface as `- guard:  (L5)` in a reviewer's PR.
 */

function base(overrides: Partial<Rule> & { type: Rule["type"] }): Rule {
  return {
    type: overrides.type,
    line: overrides.line ?? 1,
    condition: overrides.condition ?? null,
    what: overrides.what ?? null,
    expr: overrides.expr ?? null,
    loopKind: overrides.loopKind ?? null,
  }
}

describe("ruleRow — happy paths", () => {
  it("guard with condition", () => {
    expect(ruleRow(base({ type: "guard", line: 5, condition: "x > 0" }))).toBe(
      "- guard: `x > 0` (L5)",
    )
  })
  it("throw with what", () => {
    expect(ruleRow(base({ type: "throw", line: 8, what: "new E()" }))).toBe(
      "- throw: `new E()` (L8)",
    )
  })
  it("return with expr", () => {
    expect(ruleRow(base({ type: "return", line: 20, expr: "value" }))).toBe(
      "- return: `value` (L20)",
    )
  })
  it("loop with loopKind", () => {
    expect(ruleRow(base({ type: "loop", line: 30, loopKind: "for" }))).toBe("- loop (`for`) (L30)")
  })
  it("try (no per-type payload required)", () => {
    expect(ruleRow(base({ type: "try", line: 40 }))).toBe("- try (L40)")
  })
  it("switch with condition", () => {
    expect(ruleRow(base({ type: "switch", line: 50, condition: "kind" }))).toBe(
      "- switch: `kind` (L50)",
    )
  })
  it("match with condition", () => {
    expect(ruleRow(base({ type: "match", line: 60, condition: "kind" }))).toBe(
      "- match: `kind` (L60)",
    )
  })
})

describe("ruleRow — invariant violations throw", () => {
  it("guard without condition throws", () => {
    expect(() => ruleRow(base({ type: "guard", line: 5 }))).toThrow(ProjectionInvariantError)
    expect(() => ruleRow(base({ type: "guard", line: 5 }))).toThrow(/condition/)
  })
  it("throw without what throws", () => {
    expect(() => ruleRow(base({ type: "throw", line: 5 }))).toThrow(/what/)
  })
  it("return without expr throws", () => {
    expect(() => ruleRow(base({ type: "return", line: 5 }))).toThrow(/expr/)
  })
  it("loop without loopKind throws", () => {
    expect(() => ruleRow(base({ type: "loop", line: 5 }))).toThrow(/loopKind/)
  })
  it("switch without condition throws", () => {
    expect(() => ruleRow(base({ type: "switch", line: 5 }))).toThrow(/condition/)
  })
  it("match without condition throws", () => {
    expect(() => ruleRow(base({ type: "match", line: 5 }))).toThrow(/condition/)
  })
})

describe("ProjectionInvariantError shape", () => {
  it("carries field + subject for CI-log inspection", () => {
    try {
      ruleRow(base({ type: "guard", line: 5 }))
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectionInvariantError)
      if (e instanceof ProjectionInvariantError) {
        expect(e.field).toBe("condition")
        expect(e.subject).toContain("guard")
      }
    }
  })
})
