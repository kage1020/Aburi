import { errorFrom, rule } from "@aburi/test-support"
import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { ProjectionInvariantError, ruleRow } from "../src"

describe("ruleRow", () => {
  it.each<[string, Rule, string]>([
    [
      "a guard by its condition",
      rule({ type: "guard", line: 5, condition: "x > 0" }),
      "- guard: `x > 0` (L5)",
    ],
    [
      "a throw by what it throws",
      rule({ type: "throw", line: 8, what: "new E()" }),
      "- throw: `new E()` (L8)",
    ],
    [
      "a return by its expression",
      rule({ type: "return", line: 20, expr: "value" }),
      "- return: `value` (L20)",
    ],
    [
      "a loop by its kind",
      rule({ type: "loop", line: 30, loopKind: "for" }),
      "- loop (`for`) (L30)",
    ],
    ["a try, which carries no payload", rule({ type: "try", line: 40 }), "- try (L40)"],
    [
      "a switch by its condition",
      rule({ type: "switch", line: 50, condition: "kind" }),
      "- switch: `kind` (L50)",
    ],
    [
      "a match by its condition",
      rule({ type: "match", line: 60, condition: "kind" }),
      "- match: `kind` (L60)",
    ],
  ])("writes %s", (_, input, row) => {
    expect(ruleRow(input)).toEqual([row])
  })

  it.each<[Rule["type"], string]>([
    ["guard", "condition"],
    ["switch", "condition"],
    ["match", "condition"],
    ["throw", "what"],
    ["return", "expr"],
    ["loop", "loopKind"],
  ])("refuses a %s without its %s, naming the field and the rule", async (type, field) => {
    const error = await errorFrom(ProjectionInvariantError, () => ruleRow(rule({ type, line: 5 })))
    expect(error).toMatchObject({ field, subject: `Rule(type=${type}, line=5)` })
  })
})
