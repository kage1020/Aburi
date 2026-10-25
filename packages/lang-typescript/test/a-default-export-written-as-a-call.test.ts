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
    ["an arrow", "export default withAuth(() => { q() })", ["q"]],
    ["a named function expression", "export default memo(function Row() { r() })", ["r"]],
    ["a call behind parentheses", "export default (withAuth(() => { q() }))", ["q"]],
    ["a call behind `as`", "export default withAuth(() => { q() }) as Handler", ["q"]],
    [
      "every function handed to a call on its chain",
      "export default compose(log)(() => { a() }, () => { b() })",
      ["a", "b"],
    ],
  ])("walks %s, and not the call that wraps it", async (_label, source, calls) => {
    expect(await idsOf(source)).toEqual([DEFAULT])
    expect(await callsOf(source, DEFAULT)).toEqual(calls)
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
