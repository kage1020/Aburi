import { describe, expect, it } from "vitest"
import { parseTypescriptFile } from "../src/index"

async function parseAndImports(source: string) {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return { errors: result.errors, imports: result.imports }
}

describe("import extraction", () => {
  it("LP24: named import", async () => {
    const { imports } = await parseAndImports("import { X } from './y'")
    expect(imports).toEqual([{ source: "./y", symbols: ["X"], line: 1, dynamic: false }])
  })

  it("LP25: namespace import", async () => {
    const { imports } = await parseAndImports("import * as Y from 'z'")
    expect(imports).toEqual([
      { source: "z", symbols: "*", line: 1, dynamic: false, namespaceBinding: "Y" },
    ])
  })

  it("carries the ` as ` alias on an aliased named import", async () => {
    const { imports } = await parseAndImports("import { A as B } from './x'")
    expect(imports).toEqual([{ source: "./x", symbols: ["A as B"], line: 1, dynamic: false }])
  })

  it("LP26: dynamic import()", async () => {
    const { imports } = await parseAndImports("async function f(){ return await import('./x') }")
    expect(imports).toEqual([{ source: "./x", symbols: "*", line: 1, dynamic: true }])
  })

  it("captures a default binding as a single-entry symbol list", async () => {
    const { imports } = await parseAndImports("import Foo from './foo'")
    expect(imports).toEqual([{ source: "./foo", symbols: ["Foo"], line: 1, dynamic: false }])
  })

  it("handles bare side-effect imports with a wildcard symbols entry", async () => {
    const { imports } = await parseAndImports("import './side-effect'")
    expect(imports).toEqual([{ source: "./side-effect", symbols: "*", line: 1, dynamic: false }])
  })

  it("handles named + default mixed imports", async () => {
    const { imports } = await parseAndImports("import Foo, { A, B } from './x'")
    expect(imports[0]?.symbols).toEqual(["Foo", "A", "B"])
  })

  it("captures re-exports as static edges", async () => {
    const { imports } = await parseAndImports("export { X } from './y'")
    expect(imports).toEqual([{ source: "./y", symbols: ["X"], line: 1, dynamic: false }])
  })
})
