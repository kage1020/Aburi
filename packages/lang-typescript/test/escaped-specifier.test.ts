import { describe, expect, it } from "vitest"
import { BACKSLASH, emptySpecifierErrors, importsOf } from "./fixtures/ctx"

describe("an escaped specifier names the module the author wrote", () => {
  it("keeps a sibling file relative when its leading dot is escaped", async () => {
    const { imports, errors } = await importsOf(`import x from "${BACKSLASH}x2E/e"`)

    expect(imports).toEqual([{ source: "./e", symbols: ["default as x"], line: 1, dynamic: false }])
    expect(errors).toEqual([])
  })

  it.each([
    ["a hex escape", `${BACKSLASH}x2E/e`, "./e"],
    ["a four-digit unicode escape", `${BACKSLASH}u002E/e`, "./e"],
    ["a braced unicode escape", `${BACKSLASH}u{2E}/e`, "./e"],
  ])("restores the leading dot from %s", async (_label, written, expected) => {
    const { imports } = await importsOf(`import x from "${written}"`)

    expect(imports).toEqual([
      { source: expected, symbols: ["default as x"], line: 1, dynamic: false },
    ])
  })

  it("keeps a separator that was written as an escape", async () => {
    // `./a/b` and `./ab` are two different files, and the old reader could not tell them apart.
    const { imports } = await importsOf(`import x from "./a${BACKSLASH}u002Fb"`)

    expect(imports).toEqual([
      { source: "./a/b", symbols: ["default as x"], line: 1, dynamic: false },
    ])
  })

  it.each([
    ["a tab", `./a${BACKSLASH}tb`, "./a\tb"],
    ["a newline", `./g${BACKSLASH}nh`, "./g\nh"],
    ["a quote", `./a${BACKSLASH}"b`, './a"b'],
    ["a backslash", `./a${BACKSLASH}${BACKSLASH}b`, `./a${BACKSLASH}b`],
    ["an identity escape", `./${BACKSLASH}ab`, "./ab"],
  ])("carries %s through instead of deleting it", async (_label, written, expected) => {
    const { imports, errors } = await importsOf(`import x from "${written}"`)

    // The whole edge list, not the first source: decoding changes how many edges there are as
    // well as what they say, because `dedupeEdges` keys on the decoded specifier — two
    // writings on one line that differed only by an escape now collapse into one.
    expect(imports).toEqual([
      { source: expected, symbols: ["default as x"], line: 1, dynamic: false },
    ])
    expect(errors).toEqual([])
  })

  it("stays relative when the escape sits after the dot-slash", async () => {
    const { imports } = await importsOf(`import x from "./${BACKSLASH}te"`)

    expect(imports).toEqual([
      { source: "./\te", symbols: ["default as x"], line: 1, dynamic: false },
    ])
  })

  it("decodes on the dynamic path too", async () => {
    const { imports } = await importsOf(`const m = import("./a${BACKSLASH}tb")`)

    expect(imports).toEqual([{ source: "./a\tb", symbols: "*", line: 1, dynamic: true }])
  })

  it.each([
    [
      "a named re-export",
      `export { a } from "${BACKSLASH}x2E/e"`,
      { source: "./e", symbols: ["a"], line: 1, dynamic: false },
    ],
    [
      "a wildcard re-export",
      `export * from "${BACKSLASH}x2E/e"`,
      { source: "./e", symbols: "*", line: 1, dynamic: false },
    ],
    [
      "a require-equals",
      `import x = require("${BACKSLASH}x2E/e")`,
      { source: "./e", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x" },
    ],
  ])("decodes at %s, which is the other site that reads a specifier", async (_l, source, edge) => {
    const { imports } = await importsOf(source)

    expect(imports).toEqual([edge])
  })

  it("decodes inside a template specifier", async () => {
    const { imports } = await importsOf(`const m = import(\`./a${BACKSLASH}nb\`)`)

    expect(imports).toEqual([{ source: "./a\nb", symbols: "*", line: 1, dynamic: true }])
  })

  it("reads a template whose dollar is escaped, which is not a substitution", async () => {
    const { imports } = await importsOf(`const m = import(\`./a${BACKSLASH}\${x}b\`)`)

    expect(imports[0]?.source).toBe(`./a\${x}b`)
  })
})

describe("what the empty-specifier gate sees is the decoded value", () => {
  it("keeps a literal made only of escapes, because it names characters", async () => {
    const { imports, errors } = await importsOf(`import x from "${BACKSLASH}n${BACKSLASH}t"`)

    expect(imports[0]?.source).toBe("\n\t")
    expect(emptySpecifierErrors(errors)).toEqual([])
  })
})

describe("an escape the grammar admits but ECMAScript has no value for", () => {
  it("keeps a braced escape above the largest code point instead of throwing", async () => {
    const { imports, errors } = await importsOf(`import x from "./a${BACKSLASH}u{110000}b"`)

    expect(imports).toEqual([
      { source: "./au{110000}b", symbols: ["default as x"], line: 1, dynamic: false },
    ])
    expect(errors).toEqual([])
  })

  it("keeps a digit escape, which is a SyntaxError inside a module", async () => {
    const { imports, errors } = await importsOf(`import x from "./a${BACKSLASH}1b"`)

    // Neither the sloppy-mode U+0001 nor a refusal: the characters the author typed. Nothing
    // downstream learns the specifier had no legal value, which is a gap this change does not
    // close — it is the same silence for `\1`, `\8` and `\u{110000}` alike.
    expect(imports).toEqual([
      { source: "./a1b", symbols: ["default as x"], line: 1, dynamic: false },
    ])
    expect(errors).toEqual([])
  })
})

describe("an escape the grammar refuses never reaches the decoder", () => {
  it.each([
    ["an invalid unicode escape", `./a${BACKSLASH}uZZZZb`],
    ["an invalid hex escape", `./a${BACKSLASH}xZZb`],
  ])("reports %s as a syntax error and reads what is left", async (_label, written) => {
    const { imports, errors } = await importsOf(`import x from "${written}"`)

    expect(imports[0]?.source).toBe("./a")
    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
  })

  it.each([
    ["an invalid unicode escape", `${BACKSLASH}uZZZZ`],
    ["an invalid hex escape", `${BACKSLASH}xZZ`],
  ])("does not also call a literal that is only %s empty", async (_label, written) => {
    const { errors } = await importsOf(`import x from "${written}"`)

    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
    expect(emptySpecifierErrors(errors)).toEqual([])
  })

  it("does not call one empty either when a line continuation stands beside the ERROR", async () => {
    const { errors } = await importsOf(`import x from "${BACKSLASH}\n${BACKSLASH}uZZZZ"`)

    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
    expect(emptySpecifierErrors(errors)).toEqual([])
  })
})
