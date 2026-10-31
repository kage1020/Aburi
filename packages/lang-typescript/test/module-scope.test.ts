import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { callsOf, idsOf, normalizedOf, symbolOf, walkOf } from "./fixtures/ctx"

const MODULE = "ts:src/a.ts#<module>"

describe("a module's top-level statements", () => {
  const SEED = [
    'import { prisma } from "./db"',
    "",
    "await prisma.user.deleteMany({})",
    "doThing()",
    'process.on("SIGTERM", () => shutdown())',
    "",
  ].join("\n")

  it("are one Symbol, `<module>`, that carries what running the module does", async () => {
    const symbol = await symbolOf(SEED, MODULE)

    expect(symbol).toMatchObject({
      kind: "module",
      extKind: null,
      name: "<module>",
      visibility: "internal",
      decorators: [],
      signature: null,
      derivedBy: ["module-scope"],
      source: { file: "src/a.ts", startLine: 3, endLine: 5 },
    })
    expect(await callsOf(SEED, MODULE)).toEqual([
      "prisma.user.deleteMany",
      "doThing",
      "process.on",
      "shutdown",
    ])
  })

  it("leave the declarations between them to their own Symbols", async () => {
    const source = ["a()", "export function f() { b() }", "c()", ""].join("\n")

    expect(await idsOf(source)).toEqual([MODULE, "ts:src/a.ts#f"])
    expect(await callsOf(source, MODULE)).toEqual(["a", "c"])
    expect(await callsOf(source, "ts:src/a.ts#f")).toEqual(["b"])
    expect((await symbolOf(source, MODULE)).source).toMatchObject({ startLine: 1, endLine: 3 })
  })

  it.each([
    ["an if", "if (ready) start()", ["start"], []],
    ["a for", "for (let i = 0; i < 3; i++) tick(i)", ["tick"], ["loop"]],
    ["a for…of", "for (const job of jobs) run(job)", ["run"], ["loop"]],
    ["a for await", "for await (const job of queue()) run(job)", ["queue", "run"], ["loop"]],
    ["a while", "while (pending()) drain()", ["pending", "drain"], ["loop"]],
    ["a do…while", "do drain(); while (pending())", ["drain", "pending"], ["loop"]],
    ["a try", "try { connect() } catch { retry() }", ["connect", "retry"], ["try"]],
    ["a switch", "switch (mode()) { case 1: a() }", ["mode", "a"], ["switch"]],
    ["a block", "{ setup() }", ["setup"], []],
    ["a labelled statement", "outer: for (const x of xs) visit(x)", ["visit"], ["loop"]],
    ["a throw", 'throw new Error("unsupported")', ["Error"], ["throw"]],
    [
      "an immediately invoked function",
      "(async () => { await main() })()",
      ["<computed>", "main"],
      [],
    ],
    ["a statement inside a namespace", "namespace N { setup() }", ["setup"], []],
  ])("take %s", async (_label, source, calls, rules) => {
    const walk = await walkOf(source, MODULE)

    expect(walk.calls.map((c) => c.target)).toEqual(calls)
    expect(walk.rules.map((r) => r.type)).toEqual(rules)
  })

  it.each([
    ["declarations", "export const x = make()\nexport function f() { g() }\nclass C {}"],
    [
      "imports and export clauses",
      'import "./polyfill"\nexport { x } from "./x"\nexport * from "./y"',
    ],
    ["a directive", '"use client"\nexport function Page() { return null }'],
    ["a registration, which is its own Symbol", 'app.get("/users", (req, res) => { list() })'],
    ["a default export", "export default withAuth(() => { q() })"],
    ["an ambient declaration", "declare function f(): void\ndeclare const v: number"],
    ["an empty statement", ";"],
    ["a statement the parser recovered", "export function* g(a: string): Iterable<string>;"],
  ])("leave no `<module>` for %s", async (_label, source) => {
    expect(await idsOf(source)).not.toContain(MODULE)
  })

  it("are described by their own text, and by none of the declarations between them", async () => {
    const source = (body: string, last: string) =>
      ["a()", `export function f() { ${body} }`, last, ""].join("\n")
    const before = await normalizedOf(source("b()", "c()"), MODULE)

    expect(await normalizedOf(source("z()", "c()"), MODULE)).toBe(before)
    expect(await normalizedOf(source("b()", "d()"), MODULE)).not.toBe(before)
  })

  it("are described by every one of them, not by the first alone", async () => {
    const symbol = await symbolOf("a()\nb()", MODULE)

    expect(symbol.mergedDeclarations).toHaveLength(1)
    expect(normalizeAst(symbol)).not.toBe(normalizeAst({ ...symbol, mergedDeclarations: [] }))
  })
})

describe("a function a const's initializer runs in place", () => {
  it("is the const's body", async () => {
    const source = "export const h = (() => { q() })()"
    const symbol = await symbolOf(source, "ts:src/a.ts#h")

    expect(symbol.kind).toBe("const")
    expect(symbol.derivedBy).toEqual(["invoked-function", "export-keyword"])
    expect(await callsOf(source, "ts:src/a.ts#h")).toEqual(["q"])
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#h"])
  })

  it("leads the functions the rest of the chain is handed", async () => {
    const source = "export const h = (async () => { q() })().then(() => { r() })"
    const symbol = await symbolOf(source, "ts:src/a.ts#h")

    expect(symbol.derivedBy).toEqual([
      "invoked-function",
      "call-argument-function",
      "export-keyword",
    ])
    expect(await callsOf(source, "ts:src/a.ts#h")).toEqual(["q", "r"])
  })
})
