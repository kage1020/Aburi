import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { walkFirstSymbol } from "./fixtures/ctx"

async function rulesOf(body: string): Promise<Rule[]> {
  return (await walkFirstSymbol(`export function f(a: any, b: any, c: any) {\n${body}\n}`)).rules
}

function strings(rule: Rule | undefined): (string | null)[] {
  return rule === undefined ? [] : [rule.condition, rule.what, rule.expr]
}

describe("rule text drops comments", () => {
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

  it.each([
    ["guard", "if (a /* why */ || b) throw x", "if (a  || b) throw x"],
    ["wrapped guard", "if (\n  a || // why\n  b\n) throw x", "if (\n  a || \n  b\n) throw x"],
    ["guard with a comment at each end", "if (/* why */ a /* why */) throw x", "if ( a ) throw x"],
    [
      "guard between parenthesized operands",
      "if ((a) || /* why */ (b)) throw x",
      "if ((a) ||  (b)) throw x",
    ],
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

describe("rule text is whitespace-collapsed", () => {
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
    ["re-indenting a return", "return a ?\n      b * 2 :\n      c", "return a ? b * 2 : c"],
    ["lengthening runs of spaces", "if (a  <   18 ||    b) throw x", "if (a < 18 || b) throw x"],
    ["writing a tab and a CRLF", "if (a <\t18 ||\r\n  b) throw x", "if (a < 18 || b) throw x"],
  ])("%s leaves the strings as they are", async (_label, spaced, plain) => {
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
