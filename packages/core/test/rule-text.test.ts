import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { normalizeRuleStrings, normalizeRuleText, RULE_TEXT_LIMIT } from "../src/rule-text"

describe("normalizeRuleText", () => {
  it("collapses every run of whitespace, newlines included, and trims", () => {
    expect(normalizeRuleText("  a <\n\t  b  ||\r\n c ")).toBe("a < b || c")
  })

  it("leaves a string of exactly the limit whole", () => {
    const exact = "x".repeat(RULE_TEXT_LIMIT)
    expect(normalizeRuleText(exact)).toBe(exact)
  })

  it("cuts a longer one to the first 120 characters plus `...`", () => {
    const text = `${"x".repeat(RULE_TEXT_LIMIT)}yz`
    expect(normalizeRuleText(text)).toBe(`${"x".repeat(RULE_TEXT_LIMIT)}...`)
  })

  it("collapses before it counts, so indentation does not push a rule over", () => {
    const words = Array.from({ length: 30 }, () => "ab").join("\n        ")
    expect(normalizeRuleText(words)).toBe(Array.from({ length: 30 }, () => "ab").join(" "))
  })

  it("counts code points, as the schema's maxLength does, and never splits a pair", () => {
    const text = "😀".repeat(RULE_TEXT_LIMIT + 5)
    const cut = normalizeRuleText(text)
    expect(Array.from(cut)).toHaveLength(RULE_TEXT_LIMIT + 3)
    expect(cut).toBe(`${"😀".repeat(RULE_TEXT_LIMIT)}...`)
  })

  it("is idempotent, so the scan can apply it to a rule a plugin already cut", () => {
    const once = normalizeRuleText(`${"a ".repeat(100)}`)
    expect(normalizeRuleText(once)).toBe(once)
  })
})

describe("normalizeRuleStrings", () => {
  const rule = (overrides: Partial<Rule>): Rule => ({
    type: "guard",
    line: 1,
    condition: null,
    what: null,
    expr: null,
    loopKind: null,
    ...overrides,
  })

  it("normalizes condition, what and expr, and leaves null alone", () => {
    expect(normalizeRuleStrings(rule({ condition: "a\n  || b", expr: " c " }))).toEqual(
      rule({ condition: "a || b", expr: "c" }),
    )
    expect(normalizeRuleStrings(rule({ type: "throw", what: "make(\n  x)" }))).toEqual(
      rule({ type: "throw", what: "make( x)" }),
    )
  })

  it("returns the same rule when nothing differs", () => {
    const written = rule({ condition: "a || b" })
    expect(normalizeRuleStrings(written)).toBe(written)
  })
})
