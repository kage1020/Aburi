import { describe, expect, it } from "vitest"
import { byId, symbolOf, symbolsOf } from "./fixtures/ctx"

describe("an export clause", () => {
  it.each([
    ["a function", "function f() {}\nexport { f }", "#f", "function"],
    ["a class", "class f {}\nexport { f }", "#f", "class"],
    ["a const", "const f = 1\nexport { f }", "#f", "const"],
    ["an arrow const", "const f = () => 1\nexport { f }", "#f", "function"],
    ["a call-initialised const", "const f = wrap(() => 1)\nexport { f }", "#f", "const"],
    ["a destructured binding", "const { f } = m\nexport { f }", "#f", "const"],
    ["an interface", "interface f { a: number }\nexport { f }", "#f", "interface"],
    ["a type alias", "type f = number\nexport { f }", "#f", "type"],
    ["an enum", "enum f { A }\nexport { f }", "#f", "enum"],
    ["a namespace", "namespace f { const a = 1 }\nexport { f }", "#f", "namespace"],
  ])("exports %s under its own name", async (_label, source, suffix, kind) => {
    const symbol = byId(await symbolsOf(source), suffix)

    expect(symbol.kind).toBe(kind)
    expect(symbol.visibility).toBe("public")
    expect(symbol.derivedBy).toContain("export-clause:f")
  })

  it.each([
    [
      "under another name",
      "function handler() {}\nexport { handler as POST }",
      ["export-clause:POST"],
    ],
    [
      "under several names, in the order the clauses write them",
      "const handler = make()\nexport { handler as GET }\nexport { handler as POST, handler }",
      ["export-clause:GET", "export-clause:POST", "export-clause:handler"],
    ],
    [
      "under a string name",
      'function handler() {}\nexport { handler as "x-y" }',
      ["export-clause:x-y"],
    ],
    [
      "as the default export",
      "function handler() {}\nexport { handler as default }",
      ["export-default"],
    ],
    [
      "as the default export, spelled as a string",
      'function handler() {}\nexport { handler as "default" }',
      ["export-default"],
    ],
    [
      "with a type-only clause",
      "type handler = number\nexport type { handler }",
      ["export-clause:handler"],
    ],
    [
      "with a type-only specifier",
      "type handler = number\nexport { type handler }",
      ["export-clause:handler"],
    ],
    [
      "written before the declaration",
      "export { handler }\nfunction handler() {}",
      ["export-clause:handler"],
    ],
    [
      "twice, saying so once",
      "function handler() {}\nexport { handler }\nexport { handler }",
      ["export-clause:handler"],
    ],
  ])("exports a declaration %s", async (_label, source, tokens) => {
    const symbol = byId(await symbolsOf(source), "#handler")

    expect(symbol.visibility).toBe("public")
    expect(symbol.derivedBy.filter((token) => token.startsWith("export-"))).toEqual(tokens)
  })

  it.each([
    [
      "the export keyword, across two statements",
      "export function f() {}\nexport { f as g }",
      ["export-keyword", "export-clause:g"],
    ],
    [
      "a default export written apart",
      "const f = () => 1\nexport default f\nexport { f }",
      ["variable-assigned-function", "export-default", "export-clause:f"],
    ],
  ])("joins %s", async (_label, source, derivedBy) => {
    expect(byId(await symbolsOf(source), "#f").derivedBy).toEqual(derivedBy)
  })

  it("leaves the declarations it does not name internal", async () => {
    const other = await symbolOf("function a() {}\nfunction b() {}\nexport { a }", "ts:src/a.ts#b")

    expect([other.visibility, other.derivedBy]).toEqual(["internal", []])
  })

  it.each([
    ["names another module's binding", 'const x = 1\nexport { x } from "./y"', "ts:src/a.ts#x"],
    [
      "renames another module's binding",
      'const x = 1\nexport { y as x } from "./y"',
      "ts:src/a.ts#x",
    ],
    [
      "exports the namespace a declaration is written in",
      "namespace N { const a = 1 }\nexport { N }",
      "ts:src/a.ts#N.a",
    ],
    [
      "exports the class a member is written in",
      "class C { m() {} }\nexport { C }",
      "ts:src/a.ts#C.m",
    ],
    [
      "spells a call Symbol's qname",
      "const app = 1\napp.get('/x', () => {})\nexport { app__get__$x__d0 }",
      "ts:src/a.ts#app__get__$x__d0",
    ],
  ])("is not read as exporting a declaration when it %s", async (_label, source, id) => {
    const symbol = await symbolOf(source, id)

    expect(symbol.derivedBy.filter((token) => token.startsWith("export-"))).toEqual([])
  })

  it("declares nothing for a name it re-exports from an import", async () => {
    const symbols = await symbolsOf('import { a } from "./a"\nexport { a }')

    expect(symbols.map((s) => s.name)).not.toContain("a")
  })
})
