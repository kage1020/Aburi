import type { BodyExtraction, Rule, WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, parseTypescriptFile, walkBody } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

async function walkFirstSymbol(source: string): Promise<BodyExtraction> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const symbols = extractSymbols(requireTree(result.tree), ctx)
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

// The `dynamic` diagnostic bucket of call-resolution.md §8.1 cannot be recovered
// from `target` alone: `getRepo().save()` normalizes to "getRepo.save", which is
// spelled exactly like a genuine `Class.method` qname. `dynamicReceiver` keeps
// the distinction alive across the AST boundary.
describe("walkBody — dynamicReceiver (call-resolution.md §8.1 `dynamic` bucket)", () => {
  it("flags a call-expression receiver", async () => {
    const { calls } = await walkFirstSymbol("export function f() { getRepo().save(x) }")
    const call = calls.find((c) => c.target === "getRepo.save")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("flags a subscript receiver", async () => {
    const { calls } = await walkFirstSymbol("export function f(items: any[]) { items[0].save() }")
    const call = calls.find((c) => c.target === "items.save")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("flags a parenthesized expression receiver", async () => {
    const { calls } = await walkFirstSymbol("export function f(a: any, b: any) { (a ?? b).save() }")
    const call = calls.find((c) => c.dynamicReceiver === true)
    expect(call).toBeDefined()
  })

  it("does not flag a plain qualified receiver", async () => {
    const { calls } = await walkFirstSymbol("export function f(svc: any) { svc.save() }")
    const call = calls.find((c) => c.target === "svc.save")
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("does not flag a bare identifier callee", async () => {
    const { calls } = await walkFirstSymbol("export function f() { save() }")
    const call = calls.find((c) => c.target === "save")
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("does not flag `this` / `super` receivers — those carry their own §4.7 rule", async () => {
    const { calls } = await walkFirstSymbol(
      "export function f(this: any) { this.save(); super.save() }",
    )
    expect(calls.find((c) => c.target === "this.save")?.dynamicReceiver).toBeUndefined()
    expect(calls.find((c) => c.target === "super.save")?.dynamicReceiver).toBeUndefined()
  })

  it("flags a deep chain whose innermost receiver is an expression", async () => {
    const { calls } = await walkFirstSymbol("export function f() { getRepo().users.save() }")
    const call = calls.find((c) => c.target === "getRepo.users.save")
    expect(call?.dynamicReceiver).toBe(true)
  })
})
