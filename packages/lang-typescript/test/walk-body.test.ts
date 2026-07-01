import type { BodyExtraction, Rule, WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, parseTypescriptFile, walkBody } from "../src/index"
import { makeExtractionCtx } from "./fixtures/ctx"

async function walkFirstSymbol(source: string): Promise<BodyExtraction> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const symbols = extractSymbols(result.tree, ctx)
  const target = symbols[0]
  if (target === undefined) throw new Error("no symbols in fixture")
  const walkCtx: WalkContext<Node> = { ...ctx, symbol: target }
  return walkBody(target, walkCtx)
}

function typesOf(rules: Rule[]): string[] {
  return rules.map((r) => r.type)
}

describe("walkBody — rules (LP16-LP20)", () => {
  it("LP16: `if (x) throw new E()` yields guard + throw", async () => {
    const { rules } = await walkFirstSymbol(
      "export function f(x: unknown) { if (x) throw new E() }",
    )
    expect(typesOf(rules)).toEqual(["guard", "throw"])
  })

  it("LP17: `return 1` is trivial and does not surface as a rule", async () => {
    const { rules } = await walkFirstSymbol("export function f() { return 1 }")
    expect(rules).toEqual([])
  })

  it("LP18: `return foo()` yields no rule but records the call", async () => {
    const { rules, calls } = await walkFirstSymbol("export function f() { return foo() }")
    expect(rules).toEqual([])
    expect(calls.map((c) => c.target)).toEqual(["foo"])
  })

  it("LP19: `return a + b` is non-trivial and yields a return rule", async () => {
    const { rules } = await walkFirstSymbol(
      "export function f(a: number, b: number) { return a + b }",
    )
    expect(rules).toHaveLength(1)
    const [firstRule] = rules
    if (firstRule === undefined) throw new Error("rule missing")
    expect(firstRule.type).toBe("return")
    expect(firstRule.expr).toBe("a + b")
  })

  it("LP20: `for (let i...) ...` yields a loop rule with loopKind 'for'", async () => {
    const { rules } = await walkFirstSymbol(
      "export function f() { for (let i = 0; i < 3; i++) {} }",
    )
    expect(rules.filter((r) => r.type === "loop")).toHaveLength(1)
    expect(rules.find((r) => r.type === "loop")?.loopKind).toBe("for")
  })

  it("recognizes `while` loops and marks loopKind accordingly", async () => {
    const { rules } = await walkFirstSymbol("export function f() { while (true) {} }")
    expect(rules.find((r) => r.type === "loop")?.loopKind).toBe("while")
  })

  it("recognizes `try` statements", async () => {
    const { rules } = await walkFirstSymbol("export function f() { try { doThing() } catch { } }")
    expect(rules.map((r) => r.type)).toContain("try")
  })

  it("`return this.value` is trivial (member chain from `this`)", async () => {
    const { rules } = await walkFirstSymbol("export function f(this: any) { return this.a.b.c }")
    expect(rules).toEqual([])
  })

  it("captures call targets as canonical member-chain strings", async () => {
    const { calls } = await walkFirstSymbol("export function f() { prisma.user.create() }")
    expect(calls.map((c) => c.target)).toContain("prisma.user.create")
  })

  it("tags awaited calls with inAwait=true", async () => {
    const { calls } = await walkFirstSymbol("export async function f() { await doThing() }")
    const call = calls.find((c) => c.target === "doThing")
    expect(call?.inAwait).toBe(true)
  })

  it("tags new expressions with inNew=true", async () => {
    const { calls } = await walkFirstSymbol("export function f() { new MyClass() }")
    const call = calls.find((c) => c.target === "MyClass")
    expect(call?.inNew).toBe(true)
  })

  it("captures literal argument values", async () => {
    const { calls } = await walkFirstSymbol("export function f() { doThing('users', 42, x) }")
    const call = calls.find((c) => c.target === "doThing")
    expect(call?.literalArgs).toEqual(["users", "42", null])
  })
})
