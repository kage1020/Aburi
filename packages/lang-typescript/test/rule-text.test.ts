import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { walkFirstSymbol } from "./fixtures/ctx"

/**
 * The strings a rule carries — `condition`, `what`, `expr` — are written in the form
 * ir-schema.md §8.2 gives them, not as the source spells them: no comments, whitespace
 * collapsed to one space, and cut to 120 characters plus `...`. A comment, a re-wrap or an
 * indentation change is not a change to the rule, and a long rule still fits the schema's
 * `maxLength: 123`.
 */

async function rulesOf(body: string): Promise<Rule[]> {
  return (await walkFirstSymbol(`export function f(a: any, b: any, c: any) {\n${body}\n}`)).rules
}

function strings(rule: Rule | undefined): (string | null)[] {
  return rule === undefined ? [] : [rule.condition, rule.what, rule.expr]
}

describe("LP19b: rule text drops comments", () => {
  it.each([
    ["block comment in a guard", "if (a /* why */ || b) throw x", "a || b"],
    ["line comment in a guard", "if (\n  a || // why\n  b\n) throw x", "a || b"],
    ["comment beside the parentheses", "if (/* why */ a /* why */) throw x", "a"],
    ["comment between two tokens", "if (a/**/||b) throw x", "a ||b"],
    // The space is what keeps `a - (-b)` from reading as `a--b`.
    ["comment that alone keeps two tokens apart", "if (a-/**/-b) throw x", "a- -b"],
  ])("%s", async (_label, body, condition) => {
    const [guard] = await rulesOf(body)

    expect(guard?.type).toBe("guard")
    expect(guard?.condition).toBe(condition)
  })

  it("in a return", async () => {
    const [rule] = await rulesOf("return a ? b * 0.9 /* member */ : b")

    expect(strings(rule)).toEqual([null, null, "a ? b * 0.9 : b"])
  })

  it("in a throw", async () => {
    const [rule] = await rulesOf("throw make(/* code */ 'bad')")

    expect(strings(rule)).toEqual([null, "make( 'bad')", null])
  })

  it("in a switch", async () => {
    const rules = await rulesOf("switch (a /* kind */) { case 1: return b + c }")

    expect(rules.find((r) => r.type === "switch")?.condition).toBe("a")
  })

  it("keeps comment-looking text inside a string", async () => {
    const [guard] = await rulesOf('if (a === "/* not a comment */") throw x')

    expect(guard?.condition).toBe('a === "/* not a comment */"')
  })

  // The criterion itself: deleting a comment that has whitespace, or the end of the string, on
  // at least one side leaves every rule string as it was. Each spelling without the comment
  // holds no `/`, so it is read without the comment walk, and the pair also holds that
  // shortcut to the walk's answer.
  it.each([
    ["guard", "if (a /* why */ || b) throw x", "if (a  || b) throw x"],
    ["wrapped guard", "if (\n  a || // why\n  b\n) throw x", "if (\n  a || \n  b\n) throw x"],
    ["guard's ends", "if (/* why */ a /* why */) throw x", "if ( a ) throw x"],
    ["guard's operands", "if ((a) || /* why */ (b)) throw x", "if ((a) ||  (b)) throw x"],
    ["return", "return a ? b * 0.9 /* member */ : b", "return a ? b * 0.9  : b"],
    ["throw", "throw make(/* code */ 'bad')", "throw make( 'bad')"],
    [
      "switch",
      "switch (a /* kind */) { case 1: return b + c }",
      "switch (a ) { case 1: return b + c }",
    ],
  ])("the %s reads as it does with the comment deleted", async (_label, commented, bare) => {
    const withComment = await rulesOf(commented)
    const without = await rulesOf(bare)

    expect(without.length).toBeGreaterThan(0)
    expect(withComment.map(strings)).toEqual(without.map(strings))
  })
})

describe("LP19c: rule text is whitespace-collapsed", () => {
  it("reads a re-wrapped guard as the one-line guard", async () => {
    const [wrapped] = await rulesOf(
      "if (\n    a < 18 ||\n    b ||\n    c === 1\n  ) {\n    throw x\n  }",
    )
    const [line] = await rulesOf("if (a < 18 || b || c === 1) { throw x }")

    expect(wrapped?.condition).toBe("a < 18 || b || c === 1")
    expect(wrapped?.condition).toBe(line?.condition)
  })

  it("collapses a multi-line throw", async () => {
    const [rule] = await rulesOf('throw make({\n      code: a,\n      message: "bad",\n    })')

    expect(rule?.what).toBe('make({ code: a, message: "bad", })')
  })

  it.each([
    ["re-indented return", "return a ?\n      b * 2 :\n      c", "return a ? b * 2 : c"],
    ["longer runs of spaces", "if (a  <   18 ||    b) throw x", "if (a < 18 || b) throw x"],
    ["tabs and a CRLF", "if (a <\t18 ||\r\n  b) throw x", "if (a < 18 || b) throw x"],
  ])("a %s gives the same strings", async (_label, spaced, plain) => {
    const respaced = await rulesOf(spaced)
    const single = await rulesOf(plain)

    expect(single.length).toBeGreaterThan(0)
    expect(respaced.map(strings)).toEqual(single.map(strings))
  })
})

describe("an if's condition", () => {
  it("loses only the parentheses the statement requires", async () => {
    const [guard] = await rulesOf("if ((a) || (b)) throw x")

    expect(guard?.condition).toBe("(a) || (b)")
  })
})

describe("rule text is cut to 120 characters", () => {
  const long = Array.from({ length: 20 }, (_, i) => `a.f${i} > ${i}`).join(" && ")

  it.each([
    ["guard", `if (${long}) throw x`, "condition"],
    ["return", `return ${long}`, "expr"],
    ["throw", `throw make(${long})`, "what"],
  ] as const)("%s", async (_label, body, field) => {
    const [rule] = await rulesOf(body)
    const text = rule?.[field] ?? ""

    expect(Array.from(text)).toHaveLength(123)
    expect(text.endsWith("...")).toBe(true)
    expect(long.startsWith(text.slice(0, -3).replace(/^make\(/, ""))).toBe(true)
  })

  it("leaves a 120-character rule whole", async () => {
    const exact = `a === "${"x".repeat(120 - 'a === ""'.length)}"`
    expect(exact).toHaveLength(120)
    const [guard] = await rulesOf(`if (${exact}) throw x`)

    expect(guard?.condition).toBe(exact)
  })
})

describe("a finally block's rules take the same form", () => {
  // The finally block is walked like the try block (ir-schema.md §8.2), so its rules are the
  // Symbol's and reach `logic`: a comment or a re-wrap there must not move it any more than
  // one in the try block does, and a long one must still fit the schema.
  const long = Array.from({ length: 20 }, (_, i) => `a.f${i} > ${i}`).join(" && ")

  it("drops comments and collapses whitespace", async () => {
    const rules = await rulesOf(
      "try { b() } finally {\n  if (\n    a /* why */ ||\n    c // why\n  ) return\n  throw make(\n    a, /* code */ b\n  )\n}",
    )

    expect(rules.map((r) => [r.type, ...strings(r)])).toEqual([
      ["try", null, null, null],
      ["guard", "a || c", null, null],
      ["throw", null, "make( a, b )", null],
    ])
  })

  it("cuts a long rule to 120 characters", async () => {
    const rules = await rulesOf(`try { b() } finally { if (${long}) return }`)
    const guard = rules.find((r) => r.type === "guard")

    expect(guard?.condition).toBe(`${long.slice(0, 120)}...`)
  })
})
