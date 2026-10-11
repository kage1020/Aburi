import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

describe("the export keyword is evidence on every kind", () => {
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

  it.each([
    ["exported by its own keyword", "namespace N { export const a = 1 }", "public", true],
    ["not exported by the namespace's", "export namespace N { const a = 1 }", "internal", false],
  ])("a declaration inside a namespace is %s", async (_label, source, visibility, exported) => {
    const symbol = byId(await symbolsOf(source), "#N.a")

    expect(symbol.visibility).toBe(visibility)
    expect(symbol.derivedBy.includes("export-keyword")).toBe(exported)
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
