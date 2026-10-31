import { describe, expect, it } from "vitest"
import { callsOf, idsOf, normalizedOf, symbolOf } from "./fixtures/ctx"

const DEFAULT = "ts:src/a.ts#<default>"

describe("a default export written as a call handed a function", () => {
  it("is a const named for the default export, with no signature", async () => {
    const symbol = await symbolOf("export default withAuth(async (req) => { save(req) })", DEFAULT)

    expect([symbol.kind, symbol.visibility, symbol.signature]).toEqual(["const", "public", null])
    expect(symbol.derivedBy).toEqual(["call-argument-function", "export-default"])
  })

  it.each([
    ["a call handed an arrow", "export default withAuth(() => { q() })", ["q"]],
    [
      "a call handed a named function expression",
      "export default memo(function Row() { r() })",
      ["r"],
    ],
    ["a call in parentheses", "export default (withAuth(() => { q() }))", ["q"]],
    ["a call behind `as`", "export default withAuth(() => { q() }) as Handler", ["q"]],
    ["a chain of calls", "export default compose(log)(() => { a() }, () => { b() })", ["a", "b"]],
  ])("walks the functions in %s, and not the call that wraps them", async (_label, source, calls) => {
    expect(await idsOf(source)).toEqual([DEFAULT])
    expect(await callsOf(source, DEFAULT)).toEqual(calls)
  })

  it("lays the first function out as its body and the rest beside it, over the whole statement", async () => {
    const symbol = await symbolOf(
      "export default compose(log)(() => { a() }, () => {\n  b()\n})",
      DEFAULT,
    )

    expect(symbol.bodyNode?.text).toBe("{ a() }")
    expect(symbol.mergedDeclarations?.map((d) => d.bodyNode?.text)).toEqual(["{\n  b()\n}"])
    expect(symbol.source).toMatchObject({ startLine: 1, endLine: 3 })
  })

  it("describes the whole statement, so changing the call that wraps the function is an edit", async () => {
    const wrappedBy = (wrapper: string) =>
      normalizedOf(`export default ${wrapper}(() => { q() })`, DEFAULT)

    expect(await wrappedBy("withAuth")).not.toBe(await wrappedBy("withRole"))
  })

  it.each([
    ["a call handed no function", "export default defineConfig({ plugins: [react()] })"],
    ["a function inside an argument", "export default withAuth(withLogging(() => { q() }))"],
    ["a call that names a declaration", "function Page() {}\nexport default withAuth(Page)"],
  ])("gives %s no Symbol of its own", async (_label, source) => {
    expect(await idsOf(source)).not.toContain(DEFAULT)
  })
})
