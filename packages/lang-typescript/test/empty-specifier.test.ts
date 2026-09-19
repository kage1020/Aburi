import { describe, expect, it } from "vitest"
import { BACKSLASH, emptySpecifierErrors, importsOf, parseSource } from "./fixtures/ctx"

/**
 * An empty module specifier names no module, so it cannot become an `ImportEdge` — the
 * contract in `lang-plugin.md` says `source` is non-empty, and the shared guards in
 * `@aburi/plugin-registry/plugin-input` throw when it is not.
 *
 * The grammar accepts every form below and `tsc` rejects them at resolution (TS2307, or
 * TS2882 for the bare side-effect import), so they arrive here from a half-edited file
 * rather than from anything exotic. Withdrawing the edge is therefore not enough on its own:
 * a silent drop is the failure mode this repository keeps finding, so each one is reported
 * through the recoverable-parse-error channel the file already uses for syntax errors.
 */

describe("an empty module specifier produces no edge and one recoverable error", () => {
  it.each([
    ["default import", 'import a from ""', 15, "import"],
    ["bare side-effect import", 'import ""', 8, "import"],
    ["namespace re-export", 'export * from ""', 15, "re-export"],
    ["named re-export", 'export { X } from ""', 19, "re-export"],
    ["type-only import", "import type { B } from ''", 24, "import"],
    ["require-equals", "import x = require('')", 20, "import"],
    ["dynamic import", 'const p = import("")', 18, "dynamic import"],
    ["dynamic import of an empty template", "const m = import(``)", 18, "dynamic import"],
    // What the gate sees is the *decoded* value. A line continuation joins two source lines
    // and contributes no character, so a literal that is only one names no module — where it
    // used to be an edge whose source was a backslash and a newline.
    ["import of a line continuation", `import x from "${BACKSLASH}\n"`, 15, "import"],
    ["re-export of a line continuation", `export { a } from "${BACKSLASH}\n"`, 19, "re-export"],
    ["require-equals of a line continuation", `import x = require("${BACKSLASH}\n")`, 20, "import"],
    [
      "dynamic import of a line continuation",
      `const m = import("${BACKSLASH}\n")`,
      18,
      "dynamic import",
    ],
  ])("LP26a: %s", async (_label, source, column, site) => {
    const { imports, errors, tree } = await parseSource(source)
    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors)).toEqual([
      {
        // The construct is named, because `export * from ""` is not an import and being told
        // it is sends the author looking at the wrong line.
        message: `empty module specifier: this ${site} names no module — write one, or remove the ${site}`,
        line: 1,
        column,
        recoverable: true,
      },
    ])
    // The file is kept. What withdraws one is a parse that returned no tree at all, and one
    // mid-edit import line is not a reason to discard everything else in the file.
    expect(tree).not.toBeNull()
  })

  it("LP26b: withdraws only the broken edge, not the file's other imports", async () => {
    const { imports, errors } = await importsOf(
      ['import { A } from "./a"', 'import b from ""', 'import { C } from "./c"'].join("\n"),
    )
    expect(imports).toEqual([
      { source: "./a", symbols: ["A"], line: 1, dynamic: false },
      { source: "./c", symbols: ["C"], line: 3, dynamic: false },
    ])
    expect(emptySpecifierErrors(errors)).toHaveLength(1)
    expect(emptySpecifierErrors(errors)[0]?.line).toBe(2)
  })

  it("LP26c: reports each occurrence, including the two an edge dedupe would have merged", async () => {
    // `dedupeEdges` keys on the line among other things, so the only pair it can collapse is
    // two writings on one line — which is exactly this input, and which is still two places
    // for the author to go and fix. Columns rather than lines are what tell them apart.
    const { imports, errors } = await importsOf('import a from ""; import a from ""')
    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors).map((e) => e.column)).toEqual([15, 33])
  })

  it("LP26c: reports an occurrence per line as well", async () => {
    const { errors } = await importsOf(['import a from ""', 'import b from ""'].join("\n"))
    expect(emptySpecifierErrors(errors).map((e) => e.line)).toEqual([1, 2])
  })

  it("LP26d: keeps a whitespace-only specifier, which names a module rather than nothing", async () => {
    const { imports, errors } = await importsOf('import a from " "')
    expect(imports).toEqual([{ source: " ", symbols: ["a"], line: 1, dynamic: false }])
    expect(emptySpecifierErrors(errors)).toEqual([])
  })

  it("reports the empty specifier alongside a genuine syntax error in the same file", async () => {
    const { errors } = await importsOf(['import a from ""', "function ("].join("\n"))
    expect(emptySpecifierErrors(errors)).toHaveLength(1)
    expect(errors.length).toBeGreaterThan(1)
    expect(errors.every((e) => e.recoverable)).toBe(true)
  })
})

describe("the diagnostics come out in source order", () => {
  // The dynamic-import pass runs after the statement pass, so its findings have to be merged
  // into the file's order rather than appended: three broken dynamic imports on one line
  // once handed the reader their columns counting down.
  it("orders several dynamic specifiers on one line by column", async () => {
    const { errors } = await importsOf(
      'const a = import(""); const b = import(""); const c = import("")',
    )
    expect(emptySpecifierErrors(errors).map((e) => e.column)).toEqual([18, 40, 62])
  })

  it("interleaves the dynamic pass with the statement pass by line", async () => {
    const { errors } = await importsOf(['import a from ""', 'const q = import("")'].join("\n"))
    expect(emptySpecifierErrors(errors).map((e) => [e.line, e.column])).toEqual([
      [1, 15],
      [2, 18],
    ])
  })

  it("orders a dynamic specifier written before a static one", async () => {
    const { errors } = await importsOf(['const q = import("")', 'import a from ""'].join("\n"))
    expect(emptySpecifierErrors(errors).map((e) => e.line)).toEqual([1, 2])
  })
})
