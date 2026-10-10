import { rule } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { normalizeRuleStrings, normalizeRuleText, RULE_TEXT_LIMIT } from "../src/rule-text"

describe("normalizeRuleText", () => {
  it("collapses every run of whitespace, newlines included, and trims", () => {
    expect(normalizeRuleText("  a <\n\t  b  ||\r\n c ")).toBe("a < b || c")
  })

  it("leaves a string of exactly 120 characters whole", () => {
    expect(RULE_TEXT_LIMIT).toBe(120)
    const exact = "x".repeat(120)
    expect(normalizeRuleText(exact)).toBe(exact)
  })

  it("cuts a longer one to the first 120 characters plus `...`", () => {
    expect(normalizeRuleText(`${"x".repeat(120)}yz`)).toBe(`${"x".repeat(120)}...`)
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
  it("normalizes condition, what and expr, and leaves null alone", () => {
    expect(
      normalizeRuleStrings(rule({ type: "guard", condition: "a\n  || b", expr: " c " })),
    ).toEqual(rule({ type: "guard", condition: "a || b", expr: "c" }))
    expect(normalizeRuleStrings(rule({ type: "throw", what: "make(\n  x)" }))).toEqual(
      rule({ type: "throw", what: "make( x)" }),
    )
  })

  it("returns the same rule when nothing differs", () => {
    const written = rule({ type: "guard", condition: "a || b" })
    expect(normalizeRuleStrings(written)).toBe(written)
  })
})
