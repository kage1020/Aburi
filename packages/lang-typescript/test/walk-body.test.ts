import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { BACKSLASH, walkFirstSymbol, walkOf } from "./fixtures/ctx"

function typesOf(rules: Rule[]): string[] {
  return rules.map((r) => r.type)
}

describe("walkBody — rules", () => {
  it("`if (x) throw new E()` yields guard + throw", async () => {
    const { rules } = await walkFirstSymbol(
      "export function f(x: unknown) { if (x) throw new E() }",
    )
    expect(typesOf(rules)).toEqual(["guard", "throw"])
  })

  it("`return 1` is trivial and does not surface as a rule", async () => {
    const { rules } = await walkFirstSymbol("export function f() { return 1 }")
    expect(rules).toEqual([])
  })

  it("`return foo()` yields no rule but records the call", async () => {
    const { rules, calls } = await walkFirstSymbol("export function f() { return foo() }")
    expect(rules).toEqual([])
    expect(calls.map((c) => c.target)).toEqual(["foo"])
  })

  it("`return a + b` is non-trivial and yields a return rule", async () => {
    const { rules } = await walkFirstSymbol(
      "export function f(a: number, b: number) { return a + b }",
    )
    expect(rules).toHaveLength(1)
    const [firstRule] = rules
    if (firstRule === undefined) throw new Error("rule missing")
    expect(firstRule.type).toBe("return")
    expect(firstRule.expr).toBe("a + b")
  })

  it("`for (let i...) ...` yields a loop rule with loopKind 'for'", async () => {
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

  it("reads a backtick literal with no substitution as the string it spells", async () => {
    // The same value as `'users'`, so an effect plugin reading the table or route sees it.
    const { calls } = await walkFirstSymbol(
      `export function f() { doThing(\`users\`, \`a/\${b}\`) }`,
    )
    const call = calls.find((c) => c.target === "doThing")
    expect(call?.literalArgs).toEqual(["users", null])
  })

  it("counts arguments, not the comments written between them", async () => {
    const { calls } = await walkFirstSymbol(
      "export function f() { doThing(\n  users, // soft delete is not used\n) }",
    )
    const call = calls.find((c) => c.target === "doThing")
    expect(call?.argumentCount).toBe(1)
    expect(call?.literalArgs).toEqual([null])
  })

  it("keeps literalArgs aligned when a comment leads the argument list", async () => {
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

  it("records a literal argument's escapes as the characters they name", async () => {
    const { calls } = await walkFirstSymbol(
      `export function f() { db.query("SELECT${BACKSLASH}t1") }`,
    )
    const call = calls.find((c) => c.target === "db.query")

    expect(call?.literalArgs).toEqual(["SELECT\t1"])
  })

  it("keeps two literal arguments apart when neither could be read at all", async () => {
    const { calls } = await walkFirstSymbol(
      [
        "export function f() {",
        `  db.query("${BACKSLASH}u12b/a")`,
        `  db.query("${BACKSLASH}u12b/b")`,
        "}",
      ].join("\n"),
    )

    expect(calls.map((c) => c.literalArgs)).toEqual([
      [`${BACKSLASH}u12b/a`],
      [`${BACKSLASH}u12b/b`],
    ])
  })
})

describe("walkBody — a concise arrow body", () => {
  const rulesOf = async (source: string, path?: string) =>
    (await walkFirstSymbol(source, path)).rules

  it.each([
    [
      "a comparison",
      'export const f = (u: any) => u.role === "admin"',
      'export function f(u: any) { return u.role === "admin" }',
    ],
    [
      "a ternary, in the parentheses a formatter adds",
      "export const f = (a: any, b: any) => (a > b ? a : b)",
      "export function f(a: any, b: any) { return a > b ? a : b }",
    ],
    [
      "an object literal, in the parentheses the grammar requires",
      'export const f = (a: any) => ({ ...a, status: "ok" })',
      'export function f(a: any) { return { ...a, status: "ok" } }',
    ],
    [
      "a call combined with something else",
      "export const f = (a: any) => g(a) + 1",
      "export function f(a: any) { return g(a) + 1 }",
    ],
    [
      "an awaited call in an async arrow",
      "export const f = async (a: any) => await g(a)",
      "export async function f(a: any) { return await g(a) }",
    ],
    [
      "an interpolated template literal",
      `export const f = (name: string) => \`hello \${name}\``,
      `export function f(name: string) { return \`hello \${name}\` }`,
    ],
    [
      "a non-null assertion on a member chain",
      "export const f = (u: any) => u.role!",
      "export function f(u: any) { return u.role! }",
    ],
    [
      "a curried arrow, whose returned value is the whole inner arrow",
      "export const add = (a: number) => (b: number) => a + b",
      "export function add(a: number) { return (b: number) => a + b }",
    ],
  ])("reads %s as the block spelling's `return`", async (_label, concise, block) => {
    const rules = await rulesOf(concise)

    expect(rules).toHaveLength(1)
    expect(rules).toEqual(await rulesOf(block))
  })

  it("reads a JSX body as the block spelling's `return`, markup and all", async () => {
    const rules = await rulesOf(
      'export const C = ({ label }: any) => <div className="a">{label}</div>',
      "src/a.tsx",
    )

    expect(rules.map((r) => r.expr)).toEqual(['<div className="a">{label}</div>'])
    expect(rules).toEqual(
      await rulesOf(
        'export function C({ label }: any) { return <div className="a">{label}</div> }',
        "src/a.tsx",
      ),
    )
  })

  it("leaves out the parentheses a formatter wraps JSX in, and keeps their line", async () => {
    const source = [
      "export const C = ({ label }: any) => (",
      '  <div className="a">',
      "    {label}",
      "  </div>",
      ")",
    ].join("\n")

    expect((await rulesOf(source, "src/a.tsx")).map((r) => [r.line, r.expr])).toEqual([
      [1, '<div className="a"> {label} </div>'],
    ])
  })

  it.each([
    ["one call", "(id: string) => fetchUser(id)", ["fetchUser"]],
    ["one `new`", "(id: string) => new User(id)", ["User"]],
    ["a member chain", "(u: any) => u.role", []],
    ["a literal", '() => "admin"', []],
    ["a negated name", "(x: boolean) => !x", []],
  ])("adds no rule for %s, as `return` would not", async (_label, arrow, targets) => {
    const { rules, calls } = await walkFirstSymbol(`export const f = ${arrow}`)

    expect(rules).toEqual([])
    expect(calls.map((c) => c.target)).toEqual(targets)
  })

  it.each([
    [
      "a callback inside the body",
      "export function f(xs: number[]) { return xs.map((x) => x * 2) }",
      ["xs.map"],
    ],
    [
      "a parameter default",
      "export function f(cb = (x: number) => x + 1) { return cb(1) }",
      ["cb"],
    ],
  ])("adds no rule for an arrow that is not a walk root: %s", async (_label, source, targets) => {
    const { rules, calls } = await walkFirstSymbol(source)

    expect(rules).toEqual([])
    expect(calls.map((c) => c.target)).toEqual(targets)
  })

  it("still records the calls inside a returned expression", async () => {
    const { rules, calls } = await walkFirstSymbol("export const f = (a: number) => g(a) > h(a)")

    expect(rules.map((r) => r.expr)).toEqual(["g(a) > h(a)"])
    expect(calls.map((c) => c.target)).toEqual(["g", "h"])
  })

  it("puts the rule on the body's first line, which is the opening parenthesis's", async () => {
    const bare = ["export const f = (a: number, b: number) =>", "  a + b"].join("\n")
    const wrapped = ["export const f = (a: number, b: number) => (", "  a + b", ")"].join("\n")
    const block = ["export function f(a: number, b: number) { return (", "  a + b", ") }"].join(
      "\n",
    )

    expect((await rulesOf(bare)).map((r) => [r.line, r.expr])).toEqual([[2, "a + b"]])
    expect((await rulesOf(wrapped)).map((r) => [r.line, r.expr])).toEqual([[1, "a + b"]])
    expect((await rulesOf(block)).map((r) => r.line)).toEqual([1])
  })

  it("takes off the one pair of parentheses a block `return` keeps in `expr`", async () => {
    const concise = await rulesOf("export const f = (a: any, b: any) => (a > b ? a : b)")
    const block = await rulesOf("export function f(a: any, b: any) { return (a > b ? a : b) }")

    expect(concise.map((r) => r.expr)).toEqual(["a > b ? a : b"])
    expect(block.map((r) => r.expr)).toEqual(["(a > b ? a : b)"])
  })

  it("takes off one pair only", async () => {
    expect((await rulesOf("export const f = (a: number) => ((a + 1))")).map((r) => r.expr)).toEqual(
      ["(a + 1)"],
    )
  })

  it("looks past a comment inside the parentheses", async () => {
    expect(
      (await rulesOf("export const f = () => (/* keep */ { a: 1 })")).map((r) => r.expr),
    ).toEqual(["{ a: 1 }"])
  })

  it("is call-only for a parenthesized call, where the block spelling takes a rule", async () => {
    const concise = await walkFirstSymbol("export const f = () => (g())")
    const block = await walkFirstSymbol("export function f() { return (g()) }")

    expect([concise.rules, concise.calls.map((c) => c.target)]).toEqual([[], ["g"]])
    expect([block.rules.map((r) => r.expr), block.calls.map((c) => c.target)]).toEqual([
      ["(g())"],
      ["g"],
    ])
  })

  it("reads a subscript with a computed index as a return, and records the call", async () => {
    const { rules, calls } = await walkFirstSymbol("export const f = (a: any) => a[g()]")

    expect([rules.map((r) => [r.type, r.expr]), calls.map((c) => c.target)]).toEqual([
      [["return", "a[g()]"]],
      ["g"],
    ])
  })

  it("covers a class field holding an arrow, and leaves the class without the rule", async () => {
    const source = 'export class C {\n  isAdmin = (u: any) => u.role === "admin"\n}'

    expect((await walkOf(source, "ts:src/a.ts#C")).rules).toEqual([])
    expect((await walkOf(source, "ts:src/a.ts#C.isAdmin")).rules.map((r) => r.expr)).toEqual([
      'u.role === "admin"',
    ])
  })

  it("covers a registered handler", async () => {
    const source = 'app.get("/x", (req: any, res: any) => req.user ?? res.anon)'

    expect((await walkOf(source, "ts:src/a.ts#app__get__$x__d0")).rules.map((r) => r.expr)).toEqual(
      ["req.user ?? res.anon"],
    )
  })

  it("covers a default-exported arrow", async () => {
    expect((await rulesOf("export default (x: number) => x + 1")).map((r) => r.expr)).toEqual([
      "x + 1",
    ])
  })
})

describe("walkBody — parameter defaults", () => {
  async function targetsOf(source: string): Promise<string[]> {
    return (await walkFirstSymbol(source)).calls.map((c) => c.target)
  }

  it.each([
    ["a function", "export function f(x = g()) { h() }", ["g", "h"]],
    ["an arrow", "export const a = (y = k()) => l()", ["k", "l"]],
    ["a function expression", "export const e = function (y = k()) { l() }", ["k", "l"]],
    ["a destructured parameter", "export function d({ a = mk() } = dflt()) {}", ["mk", "dflt"]],
    ["an inline handler", "app.get('/x', (req = dflt()) => handle())", ["dflt", "handle"]],
  ])("walks %s's parameter defaults with its body", async (_label, source, expected) => {
    expect(await targetsOf(source)).toEqual(expected)
  })

  it("gives a default's call the default's own line", async () => {
    const { calls } = await walkFirstSymbol("export function f(\n  x = g(),\n) {\n  h()\n}")
    expect(calls.map((c) => [c.target, c.line])).toEqual([
      ["g", 2],
      ["h", 4],
    ])
  })

  it("takes a parameter default's rules as well as its calls", async () => {
    const { rules, calls } = await walkFirstSymbol(
      "export function f(cb = () => { throw new E() }) { h() }",
    )
    expect(rules.map((r) => r.type)).toEqual(["throw"])
    expect(calls.map((c) => c.target)).toEqual(["E", "h"])
  })

  it("walks an arrow whose parameter has no parentheses", async () => {
    expect(await targetsOf("export const f = x => g(x)")).toEqual(["g"])
  })
})

describe("walkBody — dynamicReceiver", () => {
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

  it("does not flag `this` / `super` receivers — those carry their own rule", async () => {
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

describe("walkBody — unmodelled receivers answer `<computed>`", () => {
  it.each([
    ["an array literal", "return [...names].sort()", "<computed>.sort"],
    [
      "a nested array literal",
      "return [...new Set([...a, ...b])].forEach(g)",
      "<computed>.forEach",
    ],
    ["an awaited import", "return (await import('../m')).run()", "<computed>.run"],
    ["a string literal", "return 'Loading...'.toUpperCase()", "<computed>.toUpperCase"],
    ["a number literal", "return (.5).toFixed(2)", "<computed>.toFixed"],
    ["an object literal", "return ({...x}).toString()", "<computed>.toString"],
    ["a template literal", "return `a..b`.trim()", "<computed>.trim"],
    ["a constructed instance", "return new Date().getTime()", "<computed>.getTime"],
    ["an IIFE", "(async () => {\n    await load()\n  })()", "<computed>"],
    ["an array literal behind `as`", "return ([...a] as string[]).map(g)", "<computed>.map"],
    ["an array literal behind `!`", "return [...a]!.map(g)", "<computed>.map"],
    ["a type that spells a spread", "return (x as [...T]).map(g)", "<computed>.map"],
    ["a type that spans lines", "return (x as {\n    a: string\n  }).m()", "<computed>.m"],
  ])("%s", async (_label, body, target) => {
    const { calls } = await walkFirstSymbol(
      `export async function f(names: any, a: any, b: any, x: any) { ${body} }`,
    )
    const call = calls.find((c) => c.target === target)
    expect(call).toBeDefined()
    expect(call?.dynamicReceiver).toBe(true)
    for (const { target: written } of calls) {
      expect(written.split(".").every((segment) => segment.length > 0)).toBe(true)
    }
  })

  it.each([
    ["a dynamic import", 'return import("./m")', "import"],
    ["`import.meta`", 'return import.meta.resolve("./m")', "import.meta.resolve"],
    ["`new.target`", "return new.target.g()", "new.target.g"],
  ])("still names %s", async (_label, body, target) => {
    const { calls } = await walkFirstSymbol(`export async function f() { ${body} }`)
    const call = calls.find((c) => c.target === target)
    expect(call).toBeDefined()
    expect(call?.dynamicReceiver).toBeUndefined()
  })

  it("keeps the IIFE's inner calls", async () => {
    const { calls } = await walkFirstSymbol(
      "export function boot() {\n  (async () => {\n    await load()\n  })()\n}",
    )
    expect(calls.map((c) => c.target)).toEqual(["<computed>", "load"])
  })

  it("keeps a non-null assertion's text around a name", async () => {
    const { calls } = await walkFirstSymbol(
      "export function f(svc?: any) { this.repo!.save(); svc!.save() }",
    )
    expect(calls.map((c) => c.target)).toEqual(["this.repo!.save", "svc!.save"])
  })

  it.each([
    ["`as`", "(x as Foo).m()", "x as Foo.m"],
    ["`satisfies`", "(x satisfies Foo).m()", "x satisfies Foo.m"],
    ["an old-style assertion", "(<Foo>x).m()", "<Foo>x.m"],
  ])("keeps the text of %s around a name", async (_label, body, target) => {
    const { calls } = await walkFirstSymbol(`export function f(x: any) { ${body} }`)
    expect(calls.map((c) => [c.target, c.dynamicReceiver])).toEqual([[target, true]])
  })

  it("reads a non-null assertion around a call as the call it wraps", async () => {
    const { calls } = await walkFirstSymbol("export function f() { getRepo()!.save() }")
    const call = calls.find((c) => c.target === "getRepo.save")
    expect(call?.dynamicReceiver).toBe(true)
  })
})

describe("walkBody — a bracket access in a callee", () => {
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
    const { calls } = await walkFirstSymbol(
      'export function f(prisma: any) { prisma["user" "audit"].create({}) }',
    )
    const call = calls.find((c) => c.target.endsWith(".create"))
    expect(call?.target).toBe("prisma.<computed>.create")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("refuses a literal only half of which parsed", async () => {
    const { calls } = await walkFirstSymbol('export function f(obj: any) { obj["a\\u12b"].m() }')
    const call = calls.find((c) => c.target.endsWith(".m"))
    expect(call?.target).toBe("obj.<computed>.m")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("refuses a literal that spells a whole qualified name rather than one segment", async () => {
    const { calls } = await walkFirstSymbol('export function f(obj: any) { obj["a.b"].m() }')
    const call = calls.find((c) => c.target.endsWith(".m"))
    expect(call?.target).toBe("obj.<computed>.m")
    expect(call?.dynamicReceiver).toBe(true)
  })

  it("refuses a literal that spells a private name", async () => {
    const { calls } = await walkFirstSymbol('export function f(obj: any) { obj["#v"].m() }')
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
