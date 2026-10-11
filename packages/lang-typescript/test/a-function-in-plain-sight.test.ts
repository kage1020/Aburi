import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { callsOf, hintOf, idsOf, symbolOf, symbolsOf, walkOf } from "./fixtures/ctx"

describe("a function behind a wrapper is a function", () => {
  it.each([
    ["parentheses", "export const h = (() => { doThing() })"],
    ["satisfies", "export const h = ((() => { doThing() })) satisfies H"],
    ["as", "export const h = (() => { doThing() }) as any"],
    ["non-null", "export const h = (() => { doThing() })!"],
    ["nested", "export const h = (((() => { doThing() }) as any) satisfies H)"],
  ])("reads through %s", async (_label, source) => {
    const symbol = await symbolOf(source, "ts:src/a.ts#h")

    expect(symbol.kind).toBe("function")
    expect(symbol.derivedBy).toContain("variable-assigned-function")
    expect(await callsOf(source, "ts:src/a.ts#h")).toEqual(["doThing"])
  })

  it("reads the signature from the function the wrappers hold", async () => {
    const symbol = await symbolOf(
      "export const h = ((d: string, n: number) => d) as Handler",
      "ts:src/a.ts#h",
    )

    expect(symbol.signature?.inputs.map((i) => [i.name, i.type])).toEqual([
      ["d", "string"],
      ["n", "number"],
    ])
  })

  it.each([
    ["a wrapped value that is not a function", "export const h = (1) as any", false],
    ["a call, which is not a wrapper", "export const h = (withAuth(() => { q() }))", true],
    ["a call it is the callee of", "export const h = (() => { q() })()", false],
  ])("leaves %s a const", async (_label, source, hasBody) => {
    const symbol = await symbolOf(source, "ts:src/a.ts#h")

    expect([symbol.kind, symbol.bodyNode !== null]).toEqual(["const", hasBody])
  })

  it("gives a class field holding a wrapped function its own Symbol, and the class no hint", async () => {
    const source = ["export class C {", "  f = (() => { q() })", "}"].join("\n")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.f"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.f")).toEqual(["q"])
    expect(await hintOf(source, "ts:src/a.ts#C")).toBeNull()
  })
})

describe("a function a const hands to a call is the const's body", () => {
  const POST = [
    "export const POST = withAuth(async (id: number) => {",
    '  if (!id) throw new Error("missing id")',
    "  return prisma.user.delete({ where: { id } })",
    "})",
  ].join("\n")

  it("walks the wrapped handler onto the const, without the call that wraps it", async () => {
    const symbol = await symbolOf(POST, "ts:src/a.ts#POST")
    const { rules, calls } = await walkOf(POST, "ts:src/a.ts#POST")

    expect(symbol.kind).toBe("const")
    expect(symbol.signature).toBeNull()
    expect(symbol.derivedBy).toEqual(["call-argument-function", "export-keyword"])
    expect("mergedDeclarations" in symbol).toBe(false)
    expect(rules.map((r) => r.type)).toEqual(["guard", "throw"])
    expect(calls.map((c) => c.target)).toEqual(["Error", "prisma.user.delete"])
  })

  it.each([
    ["memo", "export const Row = memo(function Row(p: any) { track(p.id) })", "Row", ["track"]],
    [
      "forwardRef",
      "export const Input = forwardRef((props: any, ref: any) => { useFocus(ref) })",
      "Input",
      ["useFocus"],
    ],
    [
      "cache",
      "export const load = cache(async (id: string) => { await db.find(id) })",
      "load",
      ["db.find"],
    ],
  ])("walks the function handed to %s", async (_label, source, name, targets) => {
    expect(await callsOf(source, `ts:src/a.ts#${name}`)).toEqual(targets)
  })

  it("walks every function on the initializer's spine, in source order", async () => {
    const source = [
      "export const list = t.procedure",
      "  .use(async ({ next }: any) => { audit(); return next() })",
      "  .query(() => { db.read() })",
    ].join("\n")
    const symbol = await symbolOf(source, "ts:src/a.ts#list")

    expect(symbol.mergedDeclarations).toHaveLength(1)
    expect(await callsOf(source, "ts:src/a.ts#list")).toEqual(["audit", "next", "db.read"])
  })

  it.each([
    ["map", "export const names = users.map((u: any) => u.name)", "names", 0, []],
    [
      "a chain of collection calls",
      "export const ids = xs.filter((x: any) => ok(x)).map((x: any) => x.id)",
      "ids",
      1,
      ["ok"],
    ],
    [
      "reduce",
      "export const total = items.reduce((a: number, i: any) => { if (!i) throw new Error('x'); return a + i.n }, 0)",
      "total",
      0,
      ["Error"],
    ],
  ])("reads %s the same way, because it asks nothing about the call", async (_label, source, name, further, targets) => {
    const symbol = await symbolOf(source, `ts:src/a.ts#${name}`)

    expect(symbol.bodyNode).not.toBeNull()
    expect(symbol.derivedBy).toContain("call-argument-function")
    expect(symbol.mergedDeclarations?.length ?? 0).toBe(further)
    expect(await callsOf(source, `ts:src/a.ts#${name}`)).toEqual(targets)
  })

  it("is still described by the whole declaration, as a const with no body is", async () => {
    const withAuth = await symbolOf(POST, "ts:src/a.ts#POST")
    const withRole = await symbolOf(POST.replace("withAuth", "withRole"), "ts:src/a.ts#POST")

    expect(normalizeAst(withAuth)).not.toBe(normalizeAst(withRole))
    expect(normalizeAst(withAuth)).toBe(normalizeAst({ ...withAuth, bodyNode: null }))
  })

  it("does not describe a second wrapped function twice", async () => {
    const source = "export const h = pipe(() => { a() }, () => { b() })"
    const symbol = await symbolOf(source, "ts:src/a.ts#h")

    expect(symbol.mergedDeclarations).toHaveLength(1)
    const { mergedDeclarations: _, ...bodyless } = symbol
    expect(normalizeAst(symbol)).toBe(normalizeAst({ ...bodyless, bodyNode: null }))
  })
})

describe("what the reading leaves alone", () => {
  it.each([
    [
      "a function handed to `new`",
      "export const p = new Promise((resolve: any) => { q(resolve) })",
      "p",
    ],
    ["an initializer behind `await`", "export const r = await withRetry(() => { q() })", "r"],
    ["a generator argument", "export const w = wrap(function* () { yield q() })", "w"],
    [
      "a function in an object property",
      "export const o = useQuery({ queryFn: () => { q() } })",
      "o",
    ],
    ["a body of no width", "export const z = withAuth(async (req: any) =>)", "z"],
    [
      "a function inside a call inside an argument",
      "export const z = withAuth(withLogging(async () => { q() }))",
      "z",
    ],
    ["a call handed no function", "export const z = makeClient({ retries: 3 })", "z"],
  ])("leaves %s unwalked", async (_label, source, name) => {
    const symbol = await symbolOf(source, `ts:src/a.ts#${name}`)

    expect(symbol.kind).toBe("const")
    expect(symbol.bodyNode).toBeNull()
    expect(symbol.derivedBy).not.toContain("call-argument-function")
    expect(await callsOf(source, `ts:src/a.ts#${name}`)).toEqual([])
  })

  it("gives the bindings of a destructuring declaration no body", async () => {
    // Each binding is its own Symbol, and none of them is the call's result as a whole.
    const source = "export const { GET, POST } = createHandlers(() => { q() })"

    expect((await symbolsOf(source)).map((s) => [s.id, s.bodyNode])).toEqual([
      ["ts:src/a.ts#GET", null],
      ["ts:src/a.ts#POST", null],
    ])
  })

  it("produces no Symbol for a wrapped default export", async () => {
    expect(await symbolsOf("export default withAuth(() => { q() })")).toEqual([])
  })
})
