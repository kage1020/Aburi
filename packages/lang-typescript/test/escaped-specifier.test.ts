import type { ParseError } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { parseTypescriptFile } from "../src/index"

/**
 * An escape in a module specifier used to be deleted rather than decoded, so the reader handed
 * back a shorter string that looked perfectly well-formed and named a different module — or no
 * module at all.
 *
 * `"\x2E/e"` is the case that costs the most. It names a sibling file, and dropping the escape
 * left `/e`, which fails `isRelativeSpecifier`'s `startsWith("./")` — so call resolution's
 * relative tier never consulted the edge and every call through the binding was bucketed
 * `external`, which reads as "out of reach by construction" rather than "we misread the string".
 *
 * The decoder itself is tested as a table in `string-escape.test.ts`. What these pin is that it
 * is wired into the specifier, which is what the defect was about.
 */

const BS = String.fromCharCode(92)

async function parse(source: string) {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return { errors: result.errors, imports: result.imports }
}

function emptySpecifierErrors(errors: readonly ParseError[]): ParseError[] {
  return errors.filter((e) => e.message.includes("empty module specifier"))
}

describe("an escaped specifier names the module the author wrote", () => {
  it("keeps a sibling file relative when its leading dot is escaped", async () => {
    const { imports, errors } = await parse(`import x from "${BS}x2E/e"`)

    expect(imports[0]?.source).toBe("./e")
    expect(errors).toEqual([])
  })

  it.each([
    ["a hex escape", `${BS}x2E/e`, "./e"],
    ["a four-digit unicode escape", `${BS}u002E/e`, "./e"],
    ["a braced unicode escape", `${BS}u{2E}/e`, "./e"],
  ])("restores the leading dot from %s", async (_label, written, expected) => {
    const { imports } = await parse(`import x from "${written}"`)

    expect(imports[0]?.source).toBe(expected)
  })

  it("keeps a separator that was written as an escape", async () => {
    // `./a/b` and `./ab` are two different files, and the old reader could not tell them apart.
    const { imports } = await parse(`import x from "./a${BS}u002Fb"`)

    expect(imports[0]?.source).toBe("./a/b")
  })

  it.each([
    ["a tab", `./a${BS}tb`, "./a\tb"],
    ["a newline", `./g${BS}nh`, "./g\nh"],
    ["a quote", `./a${BS}"b`, './a"b'],
    ["a backslash", `./a${BS}${BS}b`, `./a${BS}b`],
    ["an identity escape", `./${BS}ab`, "./ab"],
  ])("carries %s through instead of deleting it", async (_label, written, expected) => {
    const { imports, errors } = await parse(`import x from "${written}"`)

    expect(imports[0]?.source).toBe(expected)
    expect(errors).toEqual([])
  })

  it("stays relative when the escape sits after the dot-slash", async () => {
    // The counterpart to the leading-dot case: this one never stopped being relative, so
    // nothing about its bucket changes — only the string, which is the same defect quieter.
    const { imports } = await parse(`import x from "./${BS}te"`)

    expect(imports[0]?.source).toBe("./\te")
  })

  it("decodes on the dynamic path too", async () => {
    const { imports } = await parse(`const m = import("./a${BS}tb")`)

    expect(imports).toEqual([{ source: "./a\tb", symbols: "*", line: 1, dynamic: true }])
  })

  it("decodes inside a template specifier", async () => {
    const { imports } = await parse(`const m = import(\`./a${BS}nb\`)`)

    expect(imports).toEqual([{ source: "./a\nb", symbols: "*", line: 1, dynamic: true }])
  })

  it("reads a template whose dollar is escaped, which is not a substitution", async () => {
    // `\$` is an `escape_sequence` and the `{x}` after it is a plain fragment, so this is a
    // fixed specifier rather than a computed one — the substitution guard is unaffected.
    const { imports } = await parse(`const m = import(\`./a${BS}\${x}b\`)`)

    expect(imports[0]?.source).toBe(`./a\${x}b`)
  })
})

describe("what the empty-specifier gate sees is the decoded value", () => {
  it("leaves a genuinely empty literal exactly as it was", async () => {
    const { imports, errors } = await parse(`import x from ""`)

    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors)).toHaveLength(1)
  })

  it("keeps a literal made only of escapes, because it names characters", async () => {
    const { imports, errors } = await parse(`import x from "${BS}n${BS}t"`)

    // Two control characters is a module name that will not resolve, which is the type
    // checker's business rather than this reader's — the gate tests emptiness, not blankness.
    expect(imports[0]?.source).toBe("\n\t")
    expect(emptySpecifierErrors(errors)).toEqual([])
  })

  it("reports a literal that is only a line continuation, which decodes to nothing", async () => {
    const { imports, errors } = await parse(`import x from "${BS}\n"`)

    // A behaviour change, and the direction is silent-wrong to diagnosed: this used to be an
    // edge whose source was a backslash and a newline. A continuation joins two lines and
    // contributes no character, so the literal names no module.
    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors)).toHaveLength(1)
  })
})

describe("an escape the grammar refuses never reaches the decoder", () => {
  it.each([
    ["an invalid unicode escape", `./a${BS}uZZZZb`],
    ["an invalid hex escape", `./a${BS}xZZb`],
  ])("reports %s as a syntax error and reads what is left", async (_label, written) => {
    const { imports, errors } = await parse(`import x from "${written}"`)

    // These parse as ERROR nodes rather than `escape_sequence`, so the reader sees one
    // fragment and the parser has already said why the rest is missing. Nothing here is
    // silent, and the decoder is not asked to repair source the grammar rejected.
    expect(imports[0]?.source).toBe("./a")
    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
  })

  it.each([
    ["an invalid unicode escape", `${BS}uZZZZ`],
    ["an invalid hex escape", `${BS}xZZ`],
  ])("does not also call a literal that is only %s empty", async (_label, written) => {
    const { errors } = await parse(`import x from "${written}"`)

    // Nothing in the literal parsed, so nothing is read from it — but the author did write a
    // module name, and saying it "names no module" on top of the syntax errors would be a
    // third diagnostic contradicting the two that are right. The quote-stripping fallback
    // answers the raw contents, which is non-empty and never reaches the gate.
    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
    expect(emptySpecifierErrors(errors)).toEqual([])
  })
})
