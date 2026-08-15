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
    ["default import", 'import a from ""', 15],
    ["bare side-effect import", 'import ""', 8],
    ["namespace re-export", 'export * from ""', 15],
    ["named re-export", 'export { X } from ""', 19],
    ["type-only import", "import type { B } from ''", 24],
    ["dynamic import", 'const p = import("")', 18],
  ])("%s", async (_label, source, column) => {
    const { imports, errors, tree } = await parse(source)
    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors)).toEqual([
      {
        message: expect.stringContaining("empty module specifier"),
        line: 1,
        column,
        recoverable: true,
      },
    ])
    // The file is kept: only `recoverable: false` withdraws it from the run, and one
    // mid-edit import line is not a reason to discard everything else in the file.
    expect(tree).not.toBeNull()
  })

  it("withdraws only the broken edge, not the file's other imports", async () => {
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

  it("reports each occurrence, where the edges would have been deduplicated", async () => {
    // `extractImports` dedupes identical edges, so two empty specifiers would have collapsed
    // into one. The diagnostics are per occurrence — there are two lines to go and fix.
    const { imports, errors } = await parse(['import a from ""', 'import b from ""'].join("\n"))
    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors).map((e) => e.line)).toEqual([1, 2])
  })

  it("keeps a whitespace-only specifier, which names a module rather than nothing", async () => {
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
