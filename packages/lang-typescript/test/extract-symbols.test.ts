import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { BACKSLASH, byId, symbolsOf } from "./fixtures/ctx"

describe("extractSymbols — structure (LP1-LP8)", () => {
  it("LP3: class method uses '.' separator", async () => {
    const symbols = await symbolsOf("export class InvoiceService { createInvoice() {} }")
    const sym = byId(symbols, "#InvoiceService.createInvoice")
    expect(sym.kind).toBe("method")
  })

  it("LP4: static method uses '::' separator", async () => {
    const symbols = await symbolsOf("export class InvoiceService { static fromJson() {} }")
    const sym = byId(symbols, "#InvoiceService::fromJson")
    expect(sym.kind).toBe("method")
    expect(sym.derivedBy).toContain("static-method")
  })

  it("LP6: default export of an anonymous function has qname <default>", async () => {
    const symbols = await symbolsOf("export default function () {}")
    const sym = byId(symbols, "#<default>")
    expect(sym.name).toBe("<default>")
    expect(sym.derivedBy).toContain("export-default")
  })

  it("LP7: `const f = () => ...` becomes a function with variable-assigned qname", async () => {
    const symbols = await symbolsOf("export const handler = () => 1")
    const sym = byId(symbols, "#handler")
    expect(sym.kind).toBe("function")
    expect(sym.derivedBy).toContain("variable-assigned-function")
  })

  it("LP8: nested namespace declaration nests the qname", async () => {
    const symbols = await symbolsOf(
      "export namespace Billing { export namespace Invoice { export function create() {} } }",
    )
    const sym = byId(symbols, "#Billing.Invoice.create")
    expect(sym.kind).toBe("function")
  })
})

describe("extractSymbols — the export keyword is evidence on every kind (LP6b)", () => {
  it.each([
    ["function", "export function f() {}", "#f", "function"],
    ["class", "export class C {}", "#C", "class"],
    ["const", "export const x = 1", "#x", "const"],
    ["arrow const", "export const g = () => 1", "#g", "function"],
    ["var", "export var v = 1", "#v", "const"],
    ["interface", "export interface I { a: number }", "#I", "interface"],
    ["type alias", "export type T = number", "#T", "type"],
    ["enum", "export enum E { A }", "#E", "enum"],
    ["namespace", "export namespace N { const a = 1 }", "#N", "namespace"],
  ])("%s: the exported spelling carries the token", async (_label, source, suffix, kind) => {
    const symbol = byId(await symbolsOf(source), suffix)
    expect(symbol.kind).toBe(kind)
    expect(symbol.visibility).toBe("public")
    expect(symbol.derivedBy).toContain("export-keyword")
  })

  it.each([
    ["function", "function f() {}", "#f"],
    ["class", "class C {}", "#C"],
    ["const", "const x = 1", "#x"],
    ["arrow const", "const g = () => 1", "#g"],
    ["var", "var v = 1", "#v"],
    ["interface", "interface I { a: number }", "#I"],
    ["type alias", "type T = number", "#T"],
    ["enum", "enum E { A }", "#E"],
    ["namespace", "namespace N { const a = 1 }", "#N"],
  ])("%s: the unexported spelling carries none", async (_label, source, suffix) => {
    const symbol = byId(await symbolsOf(source), suffix)
    expect(symbol.visibility).toBe("internal")
    expect(symbol.derivedBy).not.toContain("export-keyword")
  })

  it("a dotted namespace carries the token on every segment it declares", async () => {
    const symbols = await symbolsOf("export namespace A.B { const c = 1 }")
    for (const suffix of ["#A", "#A.B"]) {
      expect(byId(symbols, suffix).derivedBy).toContain("export-keyword")
    }
  })

  it("a declaration inside a namespace carries the token from its own keyword", async () => {
    const symbol = byId(await symbolsOf("namespace N { export const a = 1 }"), "#N.a")
    expect(symbol.visibility).toBe("public")
    expect(symbol.derivedBy).toContain("export-keyword")
  })

  it.each([
    ["a named clause", "interface I {}\nexport { I }", "#I", "export-keyword"],
    ["a default clause", "const P = () => 1\nexport { P as default }", "#P", "export-default"],
  ])("%s is not read for exportedness", async (_label, source, id, token) => {
    const symbol = byId(await symbolsOf(source), id)
    expect(symbol.visibility).toBe("internal")
    expect(symbol.derivedBy).not.toContain(token)
  })

  it.each([
    ["a plain binding", "export default const x = 1", "#x", ["export-default"]],
    [
      "a destructuring",
      "export default const { a } = m",
      "#a",
      ["destructured-binding", "export-default"],
    ],
  ])("%s written with both keywords at once answers as the default export", async (_label, source, id, expected) => {
    const symbol = byId(await symbolsOf(source), id)
    expect(symbol.visibility).toBe("public")
    expect(symbol.derivedBy).toEqual(expected)
  })

  it("a declaration inside an exported namespace is not exported by it", async () => {
    const symbol = byId(await symbolsOf("export namespace N { const a = 1 }"), "#N.a")
    expect(symbol.visibility).toBe("internal")
    expect(symbol.derivedBy).not.toContain("export-keyword")
  })

  it.each([
    ["class", "export default class C {}", "#C"],
    ["function", "export default function f() {}", "#f"],
    ["interface", "export default interface I { a: number }", "#I"],
  ])("%s: export default replaces the keyword rather than joining it", async (_l, source, id) => {
    const symbol = byId(await symbolsOf(source), id)
    expect(symbol.visibility).toBe("public")
    expect(symbol.derivedBy).toContain("export-default")
    expect(symbol.derivedBy).not.toContain("export-keyword")
  })
})

describe("extractSymbols — Signature (LP9-LP13)", () => {
  it("LP9: async function sets signature.async = true", async () => {
    const symbols = await symbolsOf("export async function f() {}")
    const sym = byId(symbols, "#f")
    expect(sym.signature?.async).toBe(true)
  })

  it("LP10: generator function sets signature.generator = true", async () => {
    const symbols = await symbolsOf("export function* g() {}")
    const sym = byId(symbols, "#g")
    expect(sym.signature?.generator).toBe(true)
  })

  it("LP11: parameters and return type populate inputs and outputs", async () => {
    const symbols = await symbolsOf(
      "export function f(a: number, b: string): boolean { return true }",
    )
    const sym = byId(symbols, "#f")
    expect(sym.signature?.inputs).toEqual([
      { name: "a", type: "number" },
      { name: "b", type: "string" },
    ])
    expect(sym.signature?.outputs).toEqual(["boolean"])
  })

  it("LP11a: a parenthesis-free arrow reports its single parameter", async () => {
    const symbols = await symbolsOf("export const f = x => x + 1")
    const sym = byId(symbols, "#f")
    expect(sym.signature?.inputs).toEqual([{ name: "x", type: "" }])
  })

  it("LP11a: the parenthesised spelling of that parameter reads the same", async () => {
    const bare = await symbolsOf("export const f = x => x + 1")
    const parenthesised = await symbolsOf("export const f = (x) => x + 1")
    expect(byId(bare, "#f").signature?.inputs).toEqual(byId(parenthesised, "#f").signature?.inputs)
  })

  it("LP11a: an async parenthesis-free arrow reports its parameter too", async () => {
    const symbols = await symbolsOf("export const f = async x => x + 1")
    const sym = byId(symbols, "#f")
    expect(sym.signature?.async).toBe(true)
    expect(sym.signature?.inputs).toEqual([{ name: "x", type: "" }])
  })

  it("LP11a: a zero-arity arrow still reports no inputs", async () => {
    const symbols = await symbolsOf("export const f = () => 1")
    const sym = byId(symbols, "#f")
    expect(sym.signature?.inputs).toEqual([])
  })

  it("LP11a: a class field holding that arrow reports its parameter too", async () => {
    const symbols = await symbolsOf("export class C { m = x => x }")
    const sym = byId(symbols, "#C.m")
    expect(sym.signature?.inputs).toEqual([{ name: "x", type: "" }])
  })

  it("LP12: typeParameters carry raw text", async () => {
    const symbols = await symbolsOf("export function f<T>() {}")
    const sym = byId(symbols, "#f")
    expect(sym.signature?.typeParameters).toEqual(["T"])
  })

  it("LP13: explicit throw new X() feeds throws[]", async () => {
    const symbols = await symbolsOf("export function f() { throw new MyError() }")
    const sym = byId(symbols, "#f")
    expect(sym.signature?.throws).toEqual(["MyError"])
  })

  it("LP13a: JSDoc @throws {ErrorType} feeds throws[]", async () => {
    const symbols = await symbolsOf(
      "/**\n * @throws {ValidationError}\n */\nexport function f() {}",
    )
    const sym = byId(symbols, "#f")
    expect(sym.signature?.throws).toContain("ValidationError")
  })
})

describe("extractSymbols — Decorators (LP14-LP15)", () => {
  it("LP14: single decorator with arguments", async () => {
    const symbols = await symbolsOf("export class C { @Post('/x') doThing() {} }")
    const sym = byId(symbols, "#C.doThing")
    expect(sym.decorators).toHaveLength(1)
    const [decorator] = sym.decorators
    if (decorator === undefined) throw new Error("decorator missing")
    expect(decorator.name).toBe("Post")
    expect(decorator.raw).toBe("Post('/x')")
    expect(decorator.arguments).toEqual(["'/x'"])
    expect(decorator.boundary).toBe(false)
  })

  it("LP15: multiple decorators surface in line order", async () => {
    const symbols = await symbolsOf("export class C {\n  @A()\n  @B()\n  m() {}\n}")
    const sym = byId(symbols, "#C.m")
    expect(sym.decorators.map((d) => d.name)).toEqual(["A", "B"])
    const first = sym.decorators[0]
    const second = sym.decorators[1]
    if (first === undefined || second === undefined) throw new Error("decorators missing")
    expect(first.line).toBeLessThan(second.line)
  })
})

describe("extractSymbols — Call promotion (module-level chained calls)", () => {
  it("CS1: promotes app.get with a path literal into a kind=call symbol", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.get('/users', (req, res) => { res.send('ok') })\n`,
    )
    const sym = byId(symbols, "#app__get__$users__d0")
    expect(sym.kind).toBe("call")
    expect(sym.bodyNode?.type).toBe("statement_block")
    expect(sym.signature).toBeNull()
    expect(sym.decorators).toEqual([])
    expect(sym.derivedBy).toContain("call-statement:app.get")
    expect(sym.derivedBy).toContain("path-literal:/users")
    expect(sym.derivedBy).toContain("inline-handler")
  })

  it("CS2: slugifies dynamic route parameters", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.get('/users/:id', h)\n`,
    )
    byId(symbols, "#app__get__$users$Zid__d0")
  })

  it("CS3: no path literal ⇒ the names the arguments carry stand in for it", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.use(logger)\n`,
    )
    const sym = byId(symbols, "#app__use__logger__d0")
    expect(sym.derivedBy).not.toContain(
      sym.derivedBy.find((tag) => tag.startsWith("path-literal:")) ?? "",
    )
    expect(sym.derivedBy).toContain("argument-names:logger")
  })

  it("CS4: registrations agreeing on (receiver, method, discriminator) get document-order suffixes", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.get('/x', a)\napp.get('/x', b)\napp.get('/x', c)\n`,
    )
    byId(symbols, "#app__get__$x__d0")
    byId(symbols, "#app__get__$x__d1")
    byId(symbols, "#app__get__$x__d2")
  })

  it("CS5: chained receiver (app.route('/x').get(h)) records chained-call, roots on app and is named by the path up the chain", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.route('/thing').get(handler)\n`,
    )
    const sym = byId(symbols, "#app__get__$thing__d0")
    expect(sym.derivedBy).toContain("chained-call")
    expect(sym.derivedBy).toContain("call-statement:app.get")
    expect(sym.derivedBy).toContain("path-literal:/thing")
  })

  it("CS5a: routes mounted through app.route with one handler name keep their ids when one is inserted", async () => {
    const ids = async (lines: string[]) =>
      (await symbolsOf(`${lines.join("\n")}\n`))
        .filter((s) => s.kind === "call")
        .map((s) => s.id)
        .sort()

    const before = await ids(["app.route('/a').get(h)", "app.route('/b').get(h)"])
    const after = await ids([
      "app.route('/new').get(h)",
      "app.route('/a').get(h)",
      "app.route('/b').get(h)",
    ])

    expect(before).toEqual(["ts:src/a.ts#app__get__$a__d0", "ts:src/a.ts#app__get__$b__d0"])
    expect(after).toEqual(["ts:src/a.ts#app__get__$new__d0", ...before].sort())
  })

  it.each([
    // The earliest path is the one the rest of the chain hangs off.
    ["the earliest of two paths", "app.route('/a').get('/b', h)", "#app__get__$a__d0", "/a"],
    // A member step between the calls is still the same chain.
    ["a path behind a member step", "app.use(h0).router.get('/x', h1)", "#app__get__$x__d0", "/x"],
    // The call that starts the chain makes the receiver: its argument is not a mount path.
    [
      "no path from the call that starts the chain",
      'require("express")().get(h)',
      "#require__get__h__d0",
      null,
    ],
  ])("CS5b: reads %s", async (_label, source, id, path) => {
    const sym = byId(await symbolsOf(`${source}\n`), id)

    const tags = sym.derivedBy.filter((tag) => tag.startsWith("path-literal:"))
    expect(tags).toEqual(path === null ? [] : [`path-literal:${path}`])
  })

  it("CS6: non-whitelisted method names (e.g. Sentry.captureException) are not promoted", async () => {
    const symbols = await symbolsOf(`Sentry.captureException(new Error('boom'))\nconst x = 1\n`)
    expect(symbols.some((s) => s.kind === "call")).toBe(false)
    byId(symbols, "#x")
  })

  it("CS7: bare-identifier calls (setup()) are not promoted — only member chains", async () => {
    const symbols = await symbolsOf(`setup()\nconst y = 2\n`)
    expect(symbols.some((s) => s.kind === "call")).toBe(false)
  })

  it("CS8: path literal ending in `__d1` does NOT collide with a duplicated `/x` (C2 regression)", async () => {
    const symbols = await symbolsOf(
      [
        `import express from "express"`,
        `const app = express()`,
        `app.get('/x', a)`,
        `app.get('/x', b)`,
        `app.get('/x__d1', c)`,
      ].join("\n"),
    )
    byId(symbols, "#app__get__$x__d0")
    byId(symbols, "#app__get__$x__d1")
    byId(symbols, "#app__get__$x__d1__d0")
    const ids = symbols.filter((s) => s.kind === "call").map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each([
    ["a hex escape", `/hex${BACKSLASH}x41fter`, "$hexAfter", "/hexAfter"],
    ["a tab", `/tab${BACKSLASH}tinside`, "$tab_inside", "/tab\tinside"],
    ["an escaped backslash", `/back${BACKSLASH}${BACKSLASH}slash`, "$back_slash", "/back\\slash"],
    ["a unicode escape", `/us${BACKSLASH}u0065rs`, "$users", "/users"],
  ])("CS9: reads %s in the path as the character it names", async (_label, path, slug, literal) => {
    const symbols = await symbolsOf(`app.get("${path}", h)`)
    const sym = byId(symbols, `#app__get__${slug}__d0`)

    expect(sym.derivedBy).toContain(`path-literal:${literal}`)
  })

  it("CS10: keeps two routes apart when neither path could be read at all", async () => {
    const symbols = await symbolsOf(
      [`app.get("${BACKSLASH}u12b/a", h)`, `app.get("${BACKSLASH}u12b/b", h)`].join("\n"),
    )

    const ids = symbols.filter((s) => s.kind === "call").map((s) => s.id)
    expect(ids).toEqual(["ts:src/a.ts#app__get___u12b$a__d0", "ts:src/a.ts#app__get___u12b$b__d0"])
  })

  it("CS11: reads a path written in backticks as the same path in quotes", async () => {
    const backtick = await symbolsOf("app.get(`/users`, h)\n")
    const quoted = await symbolsOf('app.get("/users", h)\n')

    const ids = (symbols: typeof backtick) =>
      symbols.filter((s) => s.kind === "call").map((s) => s.id)
    expect(ids(backtick)).toEqual(["ts:src/a.ts#app__get__$users__d0"])
    expect(ids(backtick)).toEqual(ids(quoted))
    expect(byId(backtick, "#app__get__$users__d0").derivedBy).toContain("path-literal:/users")
  })

  it("CS12: a backtick path with a substitution is not a path", async () => {
    // Its value is decided when it runs; the names the arguments carry stand in.
    const symbols = await symbolsOf(`app.get(\`/users/\${id}\`, h)\n`)

    const sym = byId(symbols, "#app__get__h__d0")
    expect(sym.derivedBy).toContain("argument-names:h")
    expect(sym.derivedBy.some((tag) => tag.startsWith("path-literal:"))).toBe(false)
  })

  it("CS13: inserting a registration with no path leaves the later ones their ids", async () => {
    const inline =
      "app.use((req, res, next) => {\n  if (!req.headers.authorization) return\n  next()\n})"
    const ids = async (lines: string[]) =>
      (await symbolsOf(`${lines.join("\n")}\n`))
        .filter((s) => s.kind === "call")
        .map((s) => s.id)
        .sort()

    const before = await ids(["app.use(cors())", "app.use(helmet())", "app.use(authMw)", inline])
    const after = await ids([
      "app.use(compression())",
      "app.use(cors())",
      "app.use(helmet())",
      "app.use(authMw)",
      inline,
    ])

    expect(before).toEqual([
      "ts:src/a.ts#app__use__authMw__d0",
      "ts:src/a.ts#app__use__cors__d0",
      "ts:src/a.ts#app__use__d0",
      "ts:src/a.ts#app__use__helmet__d0",
    ])
    expect(after).toEqual(["ts:src/a.ts#app__use__compression__d0", ...before].sort())
  })

  it("CS14: names a dotted reference and a call's callee by their whole path", async () => {
    const symbols = await symbolsOf(
      'app.use(express.json())\napp.use(express.static("public"))\napp.use(rateLimit({ max: 5 }), audit.log)\n',
    )

    expect(symbols.filter((s) => s.kind === "call").map((s) => s.id)).toEqual([
      "ts:src/a.ts#app__use__express_json__d0",
      "ts:src/a.ts#app__use__express_static__d0",
      "ts:src/a.ts#app__use__rateLimit$audit_log__d0",
    ])
  })

  it.each([
    ["a comment", 'app.get(/* why */ "/users", h)'],
    ["parentheses", 'app.get(("/users"), h)'],
    ["an assertion", 'app.get("/users" as string, h)'],
    ["a satisfies", 'app.get("/users" satisfies string, h)'],
  ])("CS15: reads the path past %s written in front of it", async (_label, source) => {
    const sym = byId(await symbolsOf(`${source}\n`), "#app__get__$users__d0")

    expect(sym.derivedBy).toContain("path-literal:/users")
  })

  it("CS16: an empty path says nothing, so the names the arguments carry stand in", async () => {
    // A slug of nothing left the bare `app__get` stem and tagged a path the id does not hold.
    const sym = byId(await symbolsOf('app.get("", h)\n'), "#app__get__h__d0")

    expect(sym.derivedBy).toContain("argument-names:h")
    expect(sym.derivedBy.some((tag) => tag.startsWith("path-literal:"))).toBe(false)
  })

  it.each([
    ["a constructor", "app.use(new Logger())", "Logger"],
    ["a spread", "app.use(...mws)", "mws"],
    ["a three-level member", "app.use(a.b.c)", "a_b_c"],
    ["a call inside a dotted path", "app.use(a.b().c)", "a_b_c"],
    ["a wrapped argument", "app.use((authMw as Handler))", "authMw"],
  ])("CS17: names %s by the name it carries", async (_label, source, names) => {
    const sym = byId(await symbolsOf(`${source}\n`), `#app__use__${names}__d0`)

    expect(sym.derivedBy).toContain(`argument-names:${names}`)
  })

  it("CS18: registrations whose names agree are told apart by order alone, and stay unique", async () => {
    const symbols = await symbolsOf(
      [
        'app.use(express.static("a"))',
        'app.use(express.static("b"))',
        "app.use(a, b)",
        "app.use(a$b)",
      ].join("\n"),
    )

    const ids = symbols.filter((s) => s.kind === "call").map((s) => s.id)
    expect(ids).toEqual([
      "ts:src/a.ts#app__use__a$b__d0",
      "ts:src/a.ts#app__use__a$b__d1",
      "ts:src/a.ts#app__use__express_static__d0",
      "ts:src/a.ts#app__use__express_static__d1",
    ])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("CS19: keeps a name outside ASCII, as the qualified-name grammar does", async () => {
    const symbols = await symbolsOf(
      ["app.use(認証)", "app.use(圧縮)", 'app.get("/ユーザー", h)', "アプリ.use(café)"].join("\n"),
    )

    expect(symbols.filter((s) => s.kind === "call").map((s) => s.id)).toEqual([
      "ts:src/a.ts#app__get__$ユーザー__d0",
      "ts:src/a.ts#app__use__圧縮__d0",
      "ts:src/a.ts#app__use__認証__d0",
      "ts:src/a.ts#アプリ__use__café__d0",
    ])
  })

  it("CS20: names a registration in Unicode NFC, whichever spelling the file was saved in", async () => {
    const decomposed = "cafe\u0301"
    const symbols = await symbolsOf(
      [`app.use(${decomposed})`, "app.use(caf\u00e9)", 'app.get("/a:\u0301", h)'].join("\n"),
    )

    const names = symbols.filter((s) => s.kind === "call").map((s) => s.name)
    expect(names).toEqual([
      "app__get__$a\u0179__d0",
      "app__use__caf\u00e9__d0",
      "app__use__caf\u00e9__d1",
    ])
    for (const name of names) expect(name).toBe(name.normalize("NFC"))
  })
})

describe("extractSymbols — SourceRange key presence (ir-schema.md Class A)", () => {
  function expectColumnKeys(symbols: SymbolCandidate<Node>[]): void {
    expect(symbols.length).toBeGreaterThan(0)
    for (const symbol of symbols) {
      expect(Object.hasOwn(symbol.source, "startColumn"), `${symbol.id}.source.startColumn`).toBe(
        true,
      )
      expect(Object.hasOwn(symbol.source, "endColumn"), `${symbol.id}.source.endColumn`).toBe(true)
      expect(symbol.source.startColumn).toBeNull()
      expect(symbol.source.endColumn).toBeNull()
    }
  }

  it("declaration extraction writes both column keys as null", async () => {
    expectColumnKeys(
      await symbolsOf(
        [
          "export function createInvoice() {}",
          "export class InvoiceService {",
          "  createInvoice() {}",
          "  static fromJson() {}",
          "}",
          "export interface Invoice { id: string }",
          "export type Money = number",
          "export enum Status { Draft }",
        ].join("\n"),
      ),
    )
  })

  it("promoted call Symbols write both column keys as null", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.get('/users', h)\napp.use(mw)\n`,
    )
    const promoted = symbols.filter((s) => s.kind === "call")
    expect(promoted.length).toBeGreaterThan(0)
    expectColumnKeys(promoted)
  })
})

describe("extractSymbols — Call promotion position independence (T2)", () => {
  const registration = `import express from "express"\nconst app = express()\napp.get('/users', h)\n`

  it("Symbol.id is unchanged when a leading import is added above the registration", async () => {
    const before = await symbolsOf(registration)
    const beforeSym = byId(before, "#app__get__$users__d0")

    const after = await symbolsOf(`import { z } from "zod"\n${registration}`)
    const afterSym = byId(after, "#app__get__$users__d0")

    expect(afterSym.id).toBe(beforeSym.id)
    expect(afterSym.source.startLine).not.toBe(beforeSym.source.startLine)
  })

  it("Symbol.id is unchanged when a leading comment block is added above the registration", async () => {
    const before = await symbolsOf(registration)
    const beforeSym = byId(before, "#app__get__$users__d0")

    const after = await symbolsOf(`// hoisted note\n// another line\n${registration}`)
    const afterSym = byId(after, "#app__get__$users__d0")

    expect(afterSym.id).toBe(beforeSym.id)
  })
})
