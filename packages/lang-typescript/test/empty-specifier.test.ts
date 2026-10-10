import { describe, expect, it } from "vitest"
import { BACKSLASH, emptySpecifierErrors, importsOf, parseSource } from "./fixtures/ctx"

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
    ["import of a line continuation", `import x from "${BACKSLASH}\n"`, 15, "import"],
    ["re-export of a line continuation", `export { a } from "${BACKSLASH}\n"`, 19, "re-export"],
    ["require-equals of a line continuation", `import x = require("${BACKSLASH}\n")`, 20, "import"],
    [
      "dynamic import of a line continuation",
      `const m = import("${BACKSLASH}\n")`,
      18,
      "dynamic import",
    ],
  ])("%s", async (_label, source, column, site) => {
    const { imports, errors, tree } = await parseSource(source)
    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors)).toEqual([
      {
        message: `empty module specifier: this ${site} names no module — write one, or remove the ${site}`,
        line: 1,
        column,
        recoverable: true,
      },
    ])
    expect(tree).not.toBeNull()
  })

  it("withdraws only the broken edge, not the file's other imports", async () => {
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

  it("keeps a whitespace-only specifier, which names a module rather than nothing", async () => {
    const { imports, errors } = await importsOf('import a from " "')
    expect(imports).toEqual([{ source: " ", symbols: ["default as a"], line: 1, dynamic: false }])
    expect(emptySpecifierErrors(errors)).toEqual([])
  })

  it("reports the empty specifier alongside a genuine syntax error in the same file", async () => {
    const { errors } = await importsOf(['import a from ""', "function ("].join("\n"))
    expect(emptySpecifierErrors(errors)).toHaveLength(1)
    expect(errors.length).toBeGreaterThan(1)
    expect(errors.every((e) => e.recoverable)).toBe(true)
  })
})

describe("each empty specifier is reported where it is written", () => {
  it.each([
    [
      "two on one line, which an edge dedupe would merge",
      'import a from ""; import a from ""',
      [
        [1, 15],
        [1, 33],
      ],
    ],
    [
      "one per line",
      'import a from ""\nimport b from ""',
      [
        [1, 15],
        [2, 15],
      ],
    ],
    [
      "dynamic ones on one line, by column",
      'const a = import(""); const b = import(""); const c = import("")',
      [
        [1, 18],
        [1, 40],
        [1, 62],
      ],
    ],
    [
      "a static one before a dynamic one",
      'import a from ""\nconst q = import("")',
      [
        [1, 15],
        [2, 18],
      ],
    ],
    [
      "a dynamic one before a static one",
      'const q = import("")\nimport a from ""',
      [
        [1, 18],
        [2, 15],
      ],
    ],
  ])("in source order, for %s", async (_label, source, positions) => {
    const { imports, errors } = await importsOf(source)

    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors).map((e) => [e.line, e.column])).toEqual(positions)
  })
})
