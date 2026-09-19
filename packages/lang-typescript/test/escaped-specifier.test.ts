import { describe, expect, it } from "vitest"
import { BACKSLASH, emptySpecifierErrors, importsOf } from "./fixtures/ctx"

/**
 * An escape in a module specifier used to be deleted rather than decoded, so the reader handed
 * back a shorter string that looked perfectly well-formed and named a different module — or no
 * module at all.
 *
 * `"\x2E/e"` is the case that costs the most. It names a sibling file, and dropping the escape
 * left `/e`, which is neither `./`- nor `../`-prefixed and so fails `isRelativeSpecifier` — so
 * call resolution's relative tier never consulted the edge and every call through the binding
 * was bucketed `external`, which reads as "out of reach by construction" rather than "we
 * misread the string".
 *
 * The decoder itself is tested as a table in `string-escape.test.ts`. What these pin is that it
 * is wired into the specifier, which is what the defect was about.
 */

describe("an escaped specifier names the module the author wrote", () => {
  it("keeps a sibling file relative when its leading dot is escaped", async () => {
    const { imports, errors } = await importsOf(`import x from "${BACKSLASH}x2E/e"`)

    expect(imports).toEqual([{ source: "./e", symbols: ["x"], line: 1, dynamic: false }])
    expect(errors).toEqual([])
  })

  it.each([
    ["a hex escape", `${BACKSLASH}x2E/e`, "./e"],
    ["a four-digit unicode escape", `${BACKSLASH}u002E/e`, "./e"],
    ["a braced unicode escape", `${BACKSLASH}u{2E}/e`, "./e"],
  ])("restores the leading dot from %s", async (_label, written, expected) => {
    const { imports } = await importsOf(`import x from "${written}"`)

    expect(imports).toEqual([{ source: expected, symbols: ["x"], line: 1, dynamic: false }])
  })

  it("keeps a separator that was written as an escape", async () => {
    // `./a/b` and `./ab` are two different files, and the old reader could not tell them apart.
    const { imports } = await importsOf(`import x from "./a${BACKSLASH}u002Fb"`)

    expect(imports).toEqual([{ source: "./a/b", symbols: ["x"], line: 1, dynamic: false }])
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
    expect(imports).toEqual([{ source: expected, symbols: ["x"], line: 1, dynamic: false }])
    expect(errors).toEqual([])
  })

  it("stays relative when the escape sits after the dot-slash", async () => {
    // The counterpart to the leading-dot case: this one never stopped being relative, so
    // nothing about its bucket changes — only the string, which is the same defect quieter.
    const { imports } = await importsOf(`import x from "./${BACKSLASH}te"`)

    expect(imports).toEqual([{ source: "./\te", symbols: ["x"], line: 1, dynamic: false }])
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
    // Every site funnels through `readModuleSpecifier` today, so these pass without the
    // decoder being wired anywhere but there. That is what they exist to keep true.
    const { imports } = await importsOf(source)

    expect(imports).toEqual([edge])
  })

  it("decodes inside a template specifier", async () => {
    const { imports } = await importsOf(`const m = import(\`./a${BACKSLASH}nb\`)`)

    expect(imports).toEqual([{ source: "./a\nb", symbols: "*", line: 1, dynamic: true }])
  })

  it("reads a template whose dollar is escaped, which is not a substitution", async () => {
    // `\$` is an `escape_sequence` and the `{x}` after it is a plain fragment, so this is a
    // fixed specifier rather than a computed one — the substitution guard is unaffected.
    const { imports } = await importsOf(`const m = import(\`./a${BACKSLASH}\${x}b\`)`)

    expect(imports[0]?.source).toBe(`./a\${x}b`)
  })
})

describe("what the empty-specifier gate sees is the decoded value", () => {
  // The other half — a literal that decodes to nothing is reported as empty — is a row of the
  // table in `empty-specifier.test.ts`.
  it("keeps a literal made only of escapes, because it names characters", async () => {
    const { imports, errors } = await importsOf(`import x from "${BACKSLASH}n${BACKSLASH}t"`)

    // Two control characters is a module name that will not resolve, which is the type
    // checker's business rather than this reader's — the gate tests emptiness, not blankness.
    expect(imports[0]?.source).toBe("\n\t")
    expect(emptySpecifierErrors(errors)).toEqual([])
  })
})

describe("an escape the grammar admits but ECMAScript has no value for", () => {
  it("keeps a braced escape above the largest code point instead of throwing", async () => {
    // `String.fromCodePoint(0x110000)` throws a `RangeError`, and the grammar hands this over
    // as an ordinary `escape_sequence`. Unguarded, the throw leaves `parseFile`, lands on the
    // per-file boundary in `scan.ts`, and the file is skipped as `extraction-failed` — its
    // Symbols, its edges and its recoverable parse errors all lost, under a field that means
    // "a plugin bug", over one character in one specifier.
    const { imports, errors } = await importsOf(`import x from "./a${BACKSLASH}u{110000}b"`)

    expect(imports).toEqual([{ source: "./au{110000}b", symbols: ["x"], line: 1, dynamic: false }])
    expect(errors).toEqual([])
  })

  it("keeps a digit escape, which is a SyntaxError inside a module", async () => {
    const { imports, errors } = await importsOf(`import x from "./a${BACKSLASH}1b"`)

    // Neither the sloppy-mode U+0001 nor a refusal: the characters the author typed. Nothing
    // downstream learns the specifier had no legal value, which is a gap this change does not
    // close — it is the same silence for `\1`, `\8` and `\u{110000}` alike.
    expect(imports).toEqual([{ source: "./a1b", symbols: ["x"], line: 1, dynamic: false }])
    expect(errors).toEqual([])
  })
})

describe("an escape the grammar refuses never reaches the decoder", () => {
  it.each([
    ["an invalid unicode escape", `./a${BACKSLASH}uZZZZb`],
    ["an invalid hex escape", `./a${BACKSLASH}xZZb`],
  ])("reports %s as a syntax error and reads what is left", async (_label, written) => {
    const { imports, errors } = await importsOf(`import x from "${written}"`)

    // These parse as ERROR nodes rather than `escape_sequence`, so the reader sees one
    // fragment and the parser has already said why the rest is missing. Nothing here is
    // silent, and the decoder is not asked to repair source the grammar rejected.
    expect(imports[0]?.source).toBe("./a")
    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
  })

  it.each([
    ["an invalid unicode escape", `${BACKSLASH}uZZZZ`],
    ["an invalid hex escape", `${BACKSLASH}xZZ`],
  ])("does not also call a literal that is only %s empty", async (_label, written) => {
    const { errors } = await importsOf(`import x from "${written}"`)

    // Nothing in the literal parsed, so nothing is read from it — but the author did write a
    // module name, and saying it "names no module" on top of the syntax errors would be a
    // third diagnostic contradicting the two that are right. The quote-stripping fallback
    // answers the raw contents, which is non-empty and never reaches the gate.
    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
    expect(emptySpecifierErrors(errors)).toEqual([])
  })

  it("does not call one empty either when a line continuation stands beside the ERROR", async () => {
    // The combination the two rows above miss. A line continuation joins two source lines
    // and contributes no character, so the literal *is* read and the read is empty — which
    // used to be indistinguishable from a whole empty literal, and produced the third
    // diagnostic the row above exists to prevent. What separates them is whether the read
    // was whole, not whether it was empty.
    const { errors } = await importsOf(`import x from "${BACKSLASH}\n${BACKSLASH}uZZZZ"`)

    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
    expect(emptySpecifierErrors(errors)).toEqual([])
  })
})
