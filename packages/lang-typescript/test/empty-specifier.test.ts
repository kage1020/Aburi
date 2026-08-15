import type { ParseError } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { parseTypescriptFile } from "../src/index"

/**
 * An empty module specifier names no module, so it cannot become an `ImportEdge` — the
 * contract in `lang-plugin.md` §4.4 says `source` is non-empty, and the shared guards in
 * `@aburi/plugin-registry/plugin-input` throw when it is not.
 *
 * The grammar accepts every form below and `tsc` rejects them at resolution (TS2307, or
 * TS2882 for the bare side-effect import), so they arrive here from a half-edited file
 * rather than from anything exotic. Withdrawing the edge is therefore not enough on its own:
 * a silent drop is the failure mode this repository keeps finding, so each one is reported
 * through the recoverable-parse-error channel the file already uses for syntax errors.
 */

async function parse(source: string) {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return { errors: result.errors, imports: result.imports, tree: result.tree }
}

function emptySpecifierErrors(errors: readonly ParseError[]): ParseError[] {
  return errors.filter((e) => e.message.includes("empty module specifier"))
}

describe("an empty module specifier produces no edge and one recoverable error", () => {
  it.each([
    ["default import", 'import a from ""', 15, "import"],
    ["bare side-effect import", 'import ""', 8, "import"],
    ["namespace re-export", 'export * from ""', 15, "re-export"],
    ["named re-export", 'export { X } from ""', 19, "re-export"],
    ["type-only import", "import type { B } from ''", 24, "import"],
    ["dynamic import", 'const p = import("")', 18, "dynamic import"],
  ])("LP26a: %s", async (_label, source, column, site) => {
    const { imports, errors, tree } = await parse(source)
    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors)).toEqual([
      {
        // The construct is named, because `export * from ""` is not an import and being told
        // it is sends the author looking at the wrong line.
        message: expect.stringContaining(`this ${site} names no module`),
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
    const { imports, errors } = await parse(
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
    const { imports, errors } = await parse('import a from ""; import a from ""')
    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors).map((e) => e.column)).toEqual([15, 33])
  })

  it("LP26c: reports an occurrence per line as well", async () => {
    const { errors } = await parse(['import a from ""', 'import b from ""'].join("\n"))
    expect(emptySpecifierErrors(errors).map((e) => e.line)).toEqual([1, 2])
  })

  it("LP26d: keeps a whitespace-only specifier, which names a module rather than nothing", async () => {
    const { imports, errors } = await parse('import a from " "')
    expect(imports).toEqual([{ source: " ", symbols: ["a"], line: 1, dynamic: false }])
    expect(emptySpecifierErrors(errors)).toEqual([])
  })

  it("reports the empty specifier alongside a genuine syntax error in the same file", async () => {
    const { errors } = await parse(['import a from ""', "function ("].join("\n"))
    expect(emptySpecifierErrors(errors)).toHaveLength(1)
    expect(errors.length).toBeGreaterThan(1)
    expect(errors.every((e) => e.recoverable)).toBe(true)
  })
})

describe("the diagnostics come out in source order", () => {
  // The dynamic-import pass is a LIFO stack walk, so it visits siblings back to front. Its
  // edges were already sorted; its errors were not, and three broken dynamic imports on one
  // line handed the reader their columns counting down.
  it("orders several dynamic specifiers on one line by column", async () => {
    const { errors } = await parse(
      'const a = import(""); const b = import(""); const c = import("")',
    )
    expect(emptySpecifierErrors(errors).map((e) => e.column)).toEqual([18, 40, 62])
  })

  it("interleaves the dynamic pass with the statement pass by line", async () => {
    const { errors } = await parse(['import a from ""', 'const q = import("")'].join("\n"))
    expect(emptySpecifierErrors(errors).map((e) => [e.line, e.column])).toEqual([
      [1, 15],
      [2, 18],
    ])
  })

  it("orders a dynamic specifier written before a static one", async () => {
    const { errors } = await parse(['const q = import("")', 'import a from ""'].join("\n"))
    expect(emptySpecifierErrors(errors).map((e) => e.line)).toEqual([1, 2])
  })
})
