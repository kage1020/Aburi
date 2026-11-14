import { describe, expect, it } from "vitest"
import { callsOf, idsOf, normalizedOf, symbolOf } from "./fixtures/ctx"

const DEFAULT = "ts:src/a.ts#<default>"

describe("a default export written as a call", () => {
  it("is a const named for the default export, with no signature", async () => {
    const symbol = await symbolOf("export default withAuth(async (req) => { save(req) })", DEFAULT)

    expect([symbol.kind, symbol.visibility, symbol.signature]).toEqual(["const", "public", null])
    expect(symbol.derivedBy).toEqual(["call-argument-function", "export-default"])
  })

  it.each([
    ["a call handed an arrow", "export default withAuth(() => { q() })", ["withAuth", "q"]],
    [
      "a call handed a named function expression",
      "export default memo(function Row() { r() })",
      ["memo", "r"],
    ],
    ["a call in parentheses", "export default (withAuth(() => { q() }))", ["withAuth", "q"]],
    ["a call behind `as`", "export default withAuth(() => { q() }) as Handler", ["withAuth", "q"]],
    [
      "a chain of calls",
      "export default compose(log)(() => { a() }, () => { b() })",
      ["compose", "compose", "a", "b"],
    ],
    [
      "a call handed no function",
      "export default defineConfig({ plugins: [react()] })",
      ["defineConfig", "react"],
    ],
    [
      "a function inside an argument",
      "export default withAuth(withLogging(() => { q() }))",
      ["withAuth", "withLogging", "q"],
    ],
  ])("walks %s, with the call that makes the value", async (_label, source, calls) => {
    expect(await idsOf(source)).toEqual([DEFAULT])
    expect(await callsOf(source, DEFAULT)).toEqual(calls)
  })

  it("holds the statement as its body and lays the functions out beside it", async () => {
    const symbol = await symbolOf(
      "export default compose(log)(() => { a() }, () => {\n  b()\n})",
      DEFAULT,
    )

    expect(symbol.bodyNode?.type).toBe("export_statement")
    expect(symbol.mergedDeclarations?.map((d) => d.bodyNode?.text)).toEqual([
      "{ a() }",
      "{\n  b()\n}",
    ])
    expect(symbol.source).toMatchObject({ startLine: 1, endLine: 3 })
  })

  it("describes the whole statement, so changing the call that wraps the function is an edit", async () => {
    const wrappedBy = (wrapper: string) =>
      normalizedOf(`export default ${wrapper}(() => { q() })`, DEFAULT)

    expect(await wrappedBy("withAuth")).not.toBe(await wrappedBy("withRole"))
  })

  it("is a Symbol beside the declaration a call names, which it does not export", async () => {
    const source = "function Page() {}\nexport default withAuth(Page)"
    const page = await symbolOf(source, "ts:src/a.ts#Page")

    expect(await idsOf(source)).toEqual([DEFAULT, "ts:src/a.ts#Page"])
    expect(await callsOf(source, DEFAULT)).toEqual(["withAuth"])
    expect(page.visibility).toBe("internal")
  })

  it.each([
    ["a name", "const f = () => 1\nexport default f"],
    ["a construction", "export default new Router()"],
  ])("gives a default export of %s no Symbol of its own", async (_label, source) => {
    expect(await idsOf(source)).not.toContain(DEFAULT)
  })
})
