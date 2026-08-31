import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, parseTypescriptFile } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

async function symbolsOf(source: string): Promise<SymbolCandidate<Node>[]> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return extractSymbols(requireTree(result.tree), makeExtractionCtx("src/a.ts", source))
}

function byId(symbols: SymbolCandidate<Node>[], suffix: string): SymbolCandidate<Node> {
  const match = symbols.find((s) => s.id.endsWith(suffix))
  if (match === undefined) {
    throw new Error(
      `no symbol with id ending in "${suffix}" (have: ${symbols.map((s) => s.id).join(", ")})`,
    )
  }
  return match
}

describe("extractSymbols — structure (LP1-LP8)", () => {
  it("LP1: top-level function", async () => {
    const symbols = await symbolsOf("export function createInvoice() {}")
    const sym = byId(symbols, "#createInvoice")
    expect(sym.kind).toBe("function")
    expect(sym.name).toBe("createInvoice")
    expect(sym.derivedBy).toContain("export-keyword")
  })

  it("LP2: class declaration", async () => {
    const symbols = await symbolsOf("export class InvoiceService {}")
    const sym = byId(symbols, "#InvoiceService")
    expect(sym.kind).toBe("class")
    expect(sym.name).toBe("InvoiceService")
  })

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

  it("LP5: interface declaration", async () => {
    const symbols = await symbolsOf("export interface Invoice { total: number }")
    const sym = byId(symbols, "#Invoice")
    expect(sym.kind).toBe("interface")
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

  it("LP13b: JSDoc @throws {ErrorType} feeds throws[]", async () => {
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
    // The handler written as an argument is what the registration runs, so it is the Symbol's
    // body. The Symbol's own signature stays null: a route has no parameters of its own.
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

  it("CS3: no path literal ⇒ qname is receiver__method__d0", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.use(logger)\n`,
    )
    const sym = byId(symbols, "#app__use__d0")
    expect(sym.derivedBy).not.toContain(
      sym.derivedBy.find((tag) => tag.startsWith("path-literal:")) ?? "",
    )
  })

  it("CS4: duplicate (receiver, method, pathSlug) triples get document-order suffixes", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.get('/x', a)\napp.get('/x', b)\napp.get('/x', c)\n`,
    )
    byId(symbols, "#app__get__$x__d0")
    byId(symbols, "#app__get__$x__d1")
    byId(symbols, "#app__get__$x__d2")
  })

  it("CS5: chained receiver (app.route('/x').get(h)) records chained-call and roots on app", async () => {
    const symbols = await symbolsOf(
      `import express from "express"\nconst app = express()\napp.route('/thing').get(handler)\n`,
    )
    const sym = byId(symbols, "#app__get__d0")
    expect(sym.derivedBy).toContain("chained-call")
    expect(sym.derivedBy).toContain("call-statement:app.get")
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
    // Without the unconditional `__d0` suffix, both calls below collapsed to
    // `#app__get__$x__d1` and integrity check #1 (Symbol id uniqueness) would fail.
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
    // All three ids must be unique — assert explicitly rather than relying on byId's
    // failure mode masking a duplicate.
    const ids = symbols.filter((s) => s.kind === "call").map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("extractSymbols — SourceRange key presence (ir-schema.md §1.1 Class A)", () => {
  /**
   * Both column keys must be own properties carrying `null`, not absent. Asserting the
   * value alone would not catch the regression this locks: `expect(x).toBeNull()` fails on
   * `undefined`, but `serializeCanonical` drops `undefined` properties, so a writer that
   * built the range without the keys would produce JSON missing them while every
   * value-based assertion elsewhere still passed.
   */
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
    // Call promotion runs through a second extractor (`call-symbols.ts`); this is the only
    // path that reaches it, so without this case the shared writer could regress on one
    // side unnoticed.
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
    // The line moved but the id did NOT — that's the whole point of the position-
    // independent qname design.
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
