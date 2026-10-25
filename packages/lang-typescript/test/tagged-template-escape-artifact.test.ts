import { describe, expect, it } from "vitest"
import { parseErrorsOf, symbolsOf } from "./fixtures/ctx"

describe("an escape only a tagged template allows is not reported as a parse error", () => {
  it.each([
    ["a Windows path under `String.raw`", "export const a = String.raw`C:\\Users\\u\\Aburi`"],
    ["a `\\x` with no hex digits", "export const b = String.raw`C:\\x\\y`"],
    ["a malformed `\\u{…}`", "export const c = tag`\\u{zz}`"],
    ["one beside a substitution", `export const d = tag\`\\unicode \${x} \\u{zz}\``],
  ])("%s", async (_label, source) => {
    expect(await parseErrorsOf(source, "src/a.ts")).toEqual([])
  })

  it("is silent in a `.mjs` file too", async () => {
    expect(
      await parseErrorsOf("export const a = String.raw`C:\\Users\\u\\Aburi`", "src/a.mjs"),
    ).toEqual([])
  })

  it("extracts the Symbol the template belongs to", async () => {
    const source = "export const root = String.raw`C:\\Users\\u\\Aburi`"
    expect((await symbolsOf(source, "src/a.ts")).map((s) => s.id)).toEqual(["ts:src/a.ts#root"])
  })
})

describe("an escape a template cannot hold still reports", () => {
  it.each([
    ["an untagged template", "export const a = `plain \\unicode`"],
    ["a string", 'export const b = "\\unicode"'],
    ["an untagged template inside a call's arguments", "export const c = f(`\\unicode`)"],
    ["a broken substitution in a tagged template", `export const d = tag\`\${foo(}\``],
    [
      "an escape under a tag with type arguments, which the grammar reads as two comparisons",
      "export const e = tag<string>`\\unicode`",
    ],
  ])("reports %s", async (_label, source) => {
    expect(await parseErrorsOf(source, "src/a.ts")).not.toEqual([])
  })
})
