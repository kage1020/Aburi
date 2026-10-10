import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { walkFirstSymbol } from "./fixtures/ctx"

async function rulesOf(body: string): Promise<Rule[]> {
  return (await walkFirstSymbol(`export function f(a: any, b: any, c: any) {\n${body}\n}`)).rules
}

/** Each rule as its type and the one text it carries. */
async function textsOf(body: string): Promise<[string, string | null][]> {
  return (await rulesOf(body)).map((r) => [r.type, r.condition ?? r.what ?? r.expr])
}

describe("rule text drops comments", () => {
  it.each([
    [
      "a block comment in a guard",
      "if (a /* why */ || b) throw x",
      [
        ["guard", "a || b"],
        ["throw", "x"],
      ],
    ],
    [
      "a line comment in a guard",
      "if (\n  a || // why\n  b\n) throw x",
      [
        ["guard", "a || b"],
        ["throw", "x"],
      ],
    ],
    [
      "a comment beside the parentheses",
      "if (/* why */ a /* why */) throw x",
      [
        ["guard", "a"],
        ["throw", "x"],
      ],
    ],
    [
      "a comment between two tokens",
      "if (a/**/||b) throw x",
      [
        ["guard", "a ||b"],
        ["throw", "x"],
      ],
    ],
    // The space is what keeps `a - (-b)` from reading as `a--b`.
    [
      "a comment that alone keeps two tokens apart",
      "if (a-/**/-b) throw x",
      [
        ["guard", "a- -b"],
        ["throw", "x"],
      ],
    ],
    [
      "a comment in a return",
      "return a ? b * 0.9 /* member */ : b",
      [["return", "a ? b * 0.9 : b"]],
    ],
    ["a comment in a throw", "throw make(/* code */ 'bad')", [["throw", "make( 'bad')"]]],
    [
      "a comment in a switch",
      "switch (a /* kind */) { case 1: return b + c }",
      [
        ["switch", "a"],
        ["return", "b + c"],
      ],
    ],
  ])("drops %s", async (_label, body, expected) => {
    expect(await textsOf(body)).toEqual(expected)
  })

  it("keeps comment-looking text inside a string", async () => {
    expect(await textsOf('if (a === "/* not a comment */") throw x')).toEqual([
      ["guard", 'a === "/* not a comment */"'],
      ["throw", "x"],
    ])
  })
})

describe("rule text is whitespace-collapsed", () => {
  it.each([
    [
      "a re-wrapped guard",
      "if (\n    a < 18 ||\n    b ||\n    c === 1\n  ) {\n    throw x\n  }",
      "a < 18 || b || c === 1",
    ],
    ["runs of spaces", "if (a  <   18 ||    b) throw x", "a < 18 || b"],
    ["a tab and a CRLF", "if (a <\t18 ||\r\n  b) throw x", "a < 18 || b"],
  ])("reads %s as the one-line guard", async (_label, body, condition) => {
    expect((await textsOf(body))[0]).toEqual(["guard", condition])
  })

  it.each([
    [
      "a multi-line throw",
      'throw make({\n      code: a,\n      message: "bad",\n    })',
      ["throw", 'make({ code: a, message: "bad", })'],
    ],
    ["a re-indented return", "return a ?\n      b * 2 :\n      c", ["return", "a ? b * 2 : c"]],
  ])("collapses %s", async (_label, body, expected) => {
    expect(await textsOf(body)).toEqual([expected])
  })
})

describe("an if's condition", () => {
  it("loses only the parentheses the statement requires, past a comment between operands", async () => {
    expect((await textsOf("if ((a) || /* why */ (b)) throw x"))[0]).toEqual(["guard", "(a) || (b)"])
  })
})

describe("a finally block's rules take the same form", () => {
  it("drops comments and collapses whitespace", async () => {
    const texts = await textsOf(
      "try { b() } finally {\n  if (\n    a /* why */ ||\n    c // why\n  ) return\n  throw make(\n    a, /* code */ b\n  )\n}",
    )

    expect(texts).toEqual([
      ["try", null],
      ["guard", "a || c"],
      ["throw", "make( a, b )"],
    ])
  })
})

describe("rule text is cut to 120 characters", () => {
  const long = Array.from({ length: 20 }, (_, i) => `a.f${i} > ${i}`).join(" && ")

  it.each([
    ["a guard", `if (${long}) throw x`, "guard", "condition"],
    ["a return", `return ${long}`, "return", "expr"],
    ["a throw", `throw make(${long})`, "throw", "what"],
    [
      "a finally block's guard",
      `try { b() } finally { if (${long}) return }`,
      "guard",
      "condition",
    ],
  ] as const)("in %s", async (_label, body, type, field) => {
    const text = (await rulesOf(body)).find((r) => r.type === type)?.[field] ?? ""

    expect(Array.from(text)).toHaveLength(123)
    expect(text.endsWith("...")).toBe(true)
    expect(long.startsWith(text.slice(0, -3).replace(/^make\(/, ""))).toBe(true)
  })

  it("leaves a 120-character rule whole", async () => {
    const exact = `a === "${"x".repeat(120 - 'a === ""'.length)}"`
    expect(exact).toHaveLength(120)

    expect((await textsOf(`if (${exact}) throw x`))[0]).toEqual(["guard", exact])
  })
})
