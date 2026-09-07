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

  it("counts arguments, not the comments written between them", async () => {
    // Comments are grammar `extras`, so tree-sitter hangs them wherever they were
    // written — a comment inside the parentheses is a named child of the argument list
    // like any argument is. Counting it made `db.delete(\n  users, // why\n)` a
    // two-argument call, which an effect plugin reads as a different API entirely.
    const { calls } = await walkFirstSymbol(
      "export function f() { doThing(\n  users, // soft delete is not used\n) }",
    )
    const call = calls.find((c) => c.target === "doThing")
    expect(call?.argumentCount).toBe(1)
    expect(call?.literalArgs).toEqual([null])
  })

  it("keeps literalArgs aligned when a comment leads the argument list", async () => {
    // The positional damage is the worse half: a leading comment took slot 0, so a
    // reader asking whether the first argument is a literal was asking about a comment.
    const { calls } = await walkFirstSymbol(
      "export function f() { doThing(/* the table */ 'users', x) }",
    )
    const call = calls.find((c) => c.target === "doThing")
    expect(call?.argumentCount).toBe(2)
    expect(call?.literalArgs).toEqual(["users", null])
  })

  it("counts a block comment between two arguments as neither", async () => {
    const { calls } = await walkFirstSymbol("export function f() { doThing(a, /* and */ b) }")
    const call = calls.find((c) => c.target === "doThing")
    expect(call?.argumentCount).toBe(2)
    expect(call?.literalArgs).toEqual([null, null])
  })

  it("reports a call whose arguments are only a comment as zero-argument", async () => {
    const { calls } = await walkFirstSymbol("export function f() { doThing(/* nothing */) }")
    const call = calls.find((c) => c.target === "doThing")
    expect(call?.argumentCount).toBe(0)
    expect(call?.literalArgs).toEqual([])
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
    const { calls } = await walkFirstSymbol("export function f(m: any, k: string) { m[k].save() }")
    const call = calls.find((c) => c.dynamicReceiver === true)
    expect(call?.target).toBe("m.<computed>.save")
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

  // A receiver shape the normalizer does not model ("opaque") is NOT evidence of
  // dynamic dispatch on its own — `svc!` still names a binding. It only counts
  // once it appears inside explicit parentheses, which is how a real expression
  // receiver has to be written. These two cases keep the `opaque` and
  // `parenthesized` branches honest; without them either could collapse into the
  // other and every test above would still pass.
  it("does not flag a non-null assertion — it still names a binding", async () => {
    const { calls } = await walkFirstSymbol("export function f(svc?: any) { svc!.save() }")
    const call = calls.find((c) => c.target.endsWith(".save"))
    expect(call).toBeDefined()
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("flags the same non-null assertion once it is parenthesized", async () => {
    const { calls } = await walkFirstSymbol("export function f(svc?: any) { (svc!).save() }")
    const call = calls.find((c) => c.target.endsWith(".save"))
    expect(call).toBeDefined()
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("flags a parenthesized type assertion receiver", async () => {
    const { calls } = await walkFirstSymbol("export function f(x: unknown) { (x as any).save() }")
    const call = calls.find((c) => c.target.endsWith(".save"))
    expect(call).toBeDefined()
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("does not flag a parenthesized plain identifier", async () => {
    const { calls } = await walkFirstSymbol("export function f(svc: any) { (svc).save() }")
    const call = calls.find((c) => c.target === "svc.save")
    expect(call?.dynamicReceiver).toBeUndefined()
  })
})

// A bracket access in a callee (`lang-plugin.md` §4.4, LP20j / LP20k). Reading only the
// object part answered `prisma.create` for `prisma["user"].create()` — a call that is
// nowhere in the program, spelled like an ordinary two-segment method call, and one
// segment short of the delegate shape `effects-prisma` needs, so the `db.write` went with
// it. A literal index is the segment it spells; anything else is the `<computed>` segment,
// which no id and no Symbol name can hold.
describe("walkBody — a bracket access in a callee (LP20j / LP20k)", () => {
  it("folds a string-literal index into the target as its own segment", async () => {
    const { calls } = await walkFirstSymbol(
      'export function f(prisma: any, data: unknown) { prisma["user"].create({ data }) }',
    )
    const call = calls.find((c) => c.target.endsWith(".create"))
    expect(call?.target).toBe("prisma.user.create")
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("decodes the literal rather than unquoting it", async () => {
    const { calls } = await walkFirstSymbol(
      'export function f(prisma: any) { prisma["us\\u0065r"].create({}) }',
    )
    expect(calls.find((c) => c.target.endsWith(".create"))?.target).toBe("prisma.user.create")
  })

  it("folds a template index that substitutes nothing", async () => {
    const { calls } = await walkFirstSymbol(
      "export function f(prisma: any) { prisma[`user`].create({}) }",
    )
    const call = calls.find((c) => c.target.endsWith(".create"))
    expect(call?.target).toBe("prisma.user.create")
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("folds a literal index the callee itself is written with", async () => {
    const { calls } = await walkFirstSymbol(
      'export function f(handlers: any) { handlers["run"]() }',
    )
    expect(calls.map((c) => c.target)).toEqual(["handlers.run"])
  })

  it("folds an optionally-chained literal index — `?.[` is the same access", async () => {
    const { calls } = await walkFirstSymbol(
      'export function f(prisma: any) { prisma?.["user"].create({}) }',
    )
    const call = calls.find((c) => c.target.endsWith(".create"))
    expect(call?.target).toBe("prisma.user.create")
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("reports an identifier index as the `<computed>` segment", async () => {
    const { calls } = await walkFirstSymbol(
      "export function f(prisma: any, model: string) { prisma[model].create({}) }",
    )
    const call = calls.find((c) => c.target.endsWith(".create"))
    expect(call?.target).toBe("prisma.<computed>.create")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("reports a numeric index as the `<computed>` segment", async () => {
    const { calls } = await walkFirstSymbol("export function f(items: any[]) { items[0].save() }")
    const call = calls.find((c) => c.target.endsWith(".save"))
    expect(call?.target).toBe("items.<computed>.save")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("reports a substituting template index as the `<computed>` segment", async () => {
    const { calls } = await walkFirstSymbol(
      `export function f(prisma: any, m: string) { prisma[\`\${m}s\`].create({}) }`,
    )
    const call = calls.find((c) => c.target.endsWith(".create"))
    expect(call?.target).toBe("prisma.<computed>.create")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("reports a literal the qualified-name grammar has no segment for as `<computed>`", async () => {
    const { calls } = await walkFirstSymbol('export function f(obj: any) { obj["a-b"].m() }')
    const call = calls.find((c) => c.target.endsWith(".m"))
    expect(call?.target).toBe("obj.<computed>.m")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("refuses an index the parser recovered rather than read", async () => {
    // `prisma["user" "audit"]` is a missing operator. Recovery drops an ERROR beside the
    // literals and leaves `"audit"` in the index field, whole and spelling a model the
    // source does not name — which would otherwise be a write on `prisma.audit` at `high`.
    const { calls } = await walkFirstSymbol(
      'export function f(prisma: any) { prisma["user" "audit"].create({}) }',
    )
    const call = calls.find((c) => c.target.endsWith(".create"))
    expect(call?.target).toBe("prisma.<computed>.create")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("refuses a literal only half of which parsed", async () => {
    // `"a\\u12b"` is an ill-formed unicode escape: the grammar reads `a` and stands the rest
    // as an ERROR *inside* the literal, so the decode is partial rather than absent.
    const { calls } = await walkFirstSymbol('export function f(obj: any) { obj["a\\u12b"].m() }')
    const call = calls.find((c) => c.target.endsWith(".m"))
    expect(call?.target).toBe("obj.<computed>.m")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("refuses a literal that spells a whole qualified name rather than one segment", async () => {
    // The predicate is `isQnameSegment`, not `isQualifiedName`: `obj["a.b"]` addresses one
    // property whose name contains a dot, and folding it would mint the two segments
    // `obj.a.b` out of it — a receiver `a` the source never wrote.
    const { calls } = await walkFirstSymbol('export function f(obj: any) { obj["a.b"].m() }')
    const call = calls.find((c) => c.target.endsWith(".m"))
    expect(call?.target).toBe("obj.<computed>.m")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("refuses an empty literal — no segment is empty", async () => {
    const { calls } = await walkFirstSymbol('export function f(obj: any) { obj[""].m() }')
    const call = calls.find((c) => c.target.endsWith(".m"))
    expect(call?.target).toBe("obj.<computed>.m")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("folds a literal index in the terminal slot — the method addressed with brackets", async () => {
    const { calls } = await walkFirstSymbol(
      'export function f(prisma: any) { prisma.user["create"]({}) }',
    )
    const call = calls.find((c) => c.target.startsWith("prisma"))
    expect(call?.target).toBe("prisma.user.create")
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("folds both slots when receiver and method are written with brackets", async () => {
    const { calls } = await walkFirstSymbol(
      'export function f(prisma: any) { prisma["user"]["create"]({}) }',
    )
    const call = calls.find((c) => c.target.startsWith("prisma"))
    expect(call?.target).toBe("prisma.user.create")
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("reports a computed callee as `<computed>` and marks it dynamic", async () => {
    // The name of the function being called is what the brackets hid, so there is no name
    // to record — and no tier could resolve one.
    const { calls } = await walkFirstSymbol(
      "export function f(handlers: any, name: string) { handlers[name]() }",
    )
    expect(calls.map((c) => c.target)).toEqual(["handlers.<computed>"])
    expect(calls[0]?.dynamicReceiver).toBe(true)
  })

  it("reports a computed method on a named receiver as `<computed>`", async () => {
    const { calls } = await walkFirstSymbol(
      "export function f(prisma: any, verb: string) { prisma.user[verb]({}) }",
    )
    const call = calls.find((c) => c.target.startsWith("prisma"))
    expect(call?.target).toBe("prisma.user.<computed>")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("folds each bracket in a chain on its own evidence", async () => {
    const { calls } = await walkFirstSymbol(
      'export function f(a: any, x: string) { a["b"][x]["c"].run() }',
    )
    const call = calls.find((c) => c.target.endsWith(".run"))
    expect(call?.target).toBe("a.b.<computed>.c.run")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("keeps an expression receiver dynamic even where the index folds", async () => {
    const { calls } = await walkFirstSymbol('export function f() { getRepo()["user"].save() }')
    const call = calls.find((c) => c.target.endsWith(".save"))
    expect(call?.target).toBe("getRepo.user.save")
    expect(call?.dynamicReceiver).toBe(true)
  })
})
