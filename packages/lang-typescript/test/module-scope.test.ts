import { describe, expect, it } from "vitest"
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
    ["a throw of a string", 'throw "unsupported"', [], ["throw"]],
    ["a with", "with (obj) { f() }", ["f"], []],
    [
      "an immediately invoked function",
      "(async () => { await main() })()",
      ["<computed>", "main"],
      [],
    ],
    ["a statement inside a namespace", "namespace N { setup() }", ["setup"], []],
    ["a statement inside an exported namespace", "export namespace N { setup() }", ["setup"], []],
    [
      "a statement inside a nested namespace",
      "namespace A { namespace B { setup() } }",
      ["setup"],
      [],
    ],
    [
      "a registration inside a namespace, which is no Symbol of its own",
      'namespace N { app.get("/x", () => { q() }) }',
      ["app.get", "q"],
      [],
    ],
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
    ["a registration handed no function, which walks its own call", "app.use(cors())"],
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
    expect(await normalizedOf("a()\nc()", MODULE)).not.toBe(await normalizedOf("a()\nb()", MODULE))
  })
})

describe("a function a const's initializer or a default export runs in place", () => {
  // The call that runs the function names none, as it does written as a statement of `<module>`.
  it.each([
    ["a const", "export const h = (() => { q() })()", "h", "export-keyword", ["<computed>", "q"]],
    [
      "a const that calls through an index on its result",
      'export const h = (() => { q() })()["run"]()',
      "h",
      "export-keyword",
      ["<computed>.run", "<computed>", "q"],
    ],
    [
      "a const that awaits it",
      "export const h = await (async () => { q() })()",
      "h",
      "export-keyword",
      ["<computed>", "q"],
    ],
    [
      "a default export",
      "export default (async () => { q() })()",
      "<default>",
      "export-default",
      ["<computed>", "q"],
    ],
  ])("is the body of %s", async (_label, source, name, exported, calls) => {
    const id = `ts:src/a.ts#${name}`
    const symbol = await symbolOf(source, id)

    expect(symbol.kind).toBe("const")
    expect(symbol.derivedBy).toEqual(["invoked-function", exported])
    expect(await callsOf(source, id)).toEqual(calls)
    expect(await idsOf(source)).toEqual([id])
  })

  it.each([
    ["a member access", "export const h = (async () => { q() })().then(() => { r() })"],
    ["an index", 'export const h = (async () => { q() })()["then"](() => { r() })'],
  ])("leads the functions the rest of the chain is handed, through %s", async (_label, source) => {
    const symbol = await symbolOf(source, "ts:src/a.ts#h")

    expect(symbol.derivedBy).toEqual([
      "invoked-function",
      "call-argument-function",
      "export-keyword",
    ])
    expect(await callsOf(source, "ts:src/a.ts#h")).toEqual([
      "<computed>.then",
      "<computed>",
      "q",
      "r",
    ])
  })
})
