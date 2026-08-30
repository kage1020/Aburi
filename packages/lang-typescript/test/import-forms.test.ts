import type { ParseError } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { parseTypescriptFile } from "../src/index"

/**
 * Three legal import forms used to produce no edge and no diagnostic, which reads exactly
 * like a file that never wrote the import: `import x = require('./m')`, an `import()` whose
 * first argument is preceded by a magic comment, and an `import()` whose specifier is a
 * template with nothing substituted into it.
 *
 * The fourth case here is what makes the third dangerous. A template *with* a substitution
 * is a computed specifier, and a reader that joined its fragments would answer `"./"` for
 * `` `./${p}` `` — a wrong edge in place of a missing one, pointing at a module the author
 * never named.
 */

async function parse(source: string) {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return { errors: result.errors, imports: result.imports }
}

function emptySpecifierErrors(errors: readonly ParseError[]): ParseError[] {
  return errors.filter((e) => e.message.includes("empty module specifier"))
}

describe("LP26f: import-equals-require binds the module object", () => {
  it("produces a namespace edge carrying the local binding", async () => {
    const { imports, errors } = await parse("import x = require('./mod')")

    // The whole edge, not its presence. The shape is the point: `symbols: "*"` with a
    // `namespaceBinding` is what sends `x.foo()` to `foo` in the target file, where a
    // default binding (`symbols: ["x"]`) would send it to `x.foo`, which names nothing
    // there. `import x = require(...)` binds the module object, as `import * as x` does.
    expect(imports).toEqual([
      { source: "./mod", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x" },
    ])
    expect(errors).toEqual([])
  })

  it("is a static edge, which is what makes it reachable by call resolution", async () => {
    const { imports } = await parse("import x = require('./mod')")

    // `dynamic` means the import was written as `import()`, and this one was not. What the
    // value buys is separate from what decides it: both loops in `callgraph.ts` that read a
    // file's edges skip a dynamic one, so `true` here would put this import out of reach of
    // call resolution — though the edge would still ship in the IR, where the effects and
    // framework plugins match on `source` and never consult `dynamic`.
    expect(imports[0]?.dynamic).toBe(false)
  })

  it("LP26g: reads a type-only require-equals on the same terms", async () => {
    const { imports } = await parse("import type x = require('./mod')")

    expect(imports).toEqual([
      { source: "./mod", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x" },
    ])
  })

  it("reads it under the CommonJS extension it is the ordinary form for", async () => {
    const result = await parseTypescriptFile({
      path: "src/a.cts",
      content: "import x = require('./mod')",
    })

    expect(result.imports).toEqual([
      { source: "./mod", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x" },
    ])
  })

  it("LP26h: says nothing about an alias that renames a local namespace", async () => {
    const { imports, errors } = await parse("import x = A.B.C")

    // `import_alias`, not `import_require_clause` — no module is named, so there is no
    // dependency to record and nothing the author did wrong.
    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })

  it("LP26a: reports an empty require specifier as the empty specifier it is", async () => {
    const { imports, errors } = await parse("import x = require('')")

    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors)).toEqual([
      {
        message:
          "empty module specifier: this import names no module — write one, or remove the import",
        line: 1,
        column: 20,
        recoverable: true,
      },
    ])
  })

  it.each([
    ["a concatenation whose first operand is a literal", `import x = require("a" + b)`],
    ["a concatenation whose second operand is a literal", `import x = require(b + "./real")`],
    ["a second argument", "import x = require('./m', 'y')"],
    ["a nested call", "import x = require(f('./m'))"],
  ])("refuses a clause that did not parse — %s", async (_label, source) => {
    const { imports, errors } = await parse(source)

    // The grammar admits nothing but a string literal here, so each of these is a syntax
    // error — but tree-sitter's recovery leaves the operand it could read as a direct child
    // of the clause, with the `source` field attached to it. Reading it produces a wrong
    // edge where there was a missing one: `"a"` for the first, `"./real"` for the second and
    // `'y'` — the second argument — for the third.
    expect(imports).toEqual([])
    // The refusal is not what makes this quiet. The parse error is reported either way, so
    // an author who writes one of these hears about it.
    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
  })

  it("keeps a require-equals beside an ordinary import, in source order", async () => {
    const { imports } = await parse("import { A } from './a'\nimport b = require('./b')")

    expect(imports).toEqual([
      { source: "./a", symbols: ["A"], line: 1, dynamic: false },
      { source: "./b", symbols: "*", line: 2, dynamic: false, namespaceBinding: "b" },
    ])
  })
})

describe("LP26i: a comment among the arguments of import()", () => {
  it("reads the specifier past a webpack magic comment", async () => {
    const { imports, errors } = await parse('const m = import(/* webpackChunkName: "x" */ "./mod")')

    expect(imports).toEqual([{ source: "./mod", symbols: "*", line: 1, dynamic: true }])
    expect(errors).toEqual([])
  })

  it("reads past two of them", async () => {
    const { imports } = await parse("const m = import(/* a */ /* b */ './mod')")

    expect(imports).toEqual([{ source: "./mod", symbols: "*", line: 1, dynamic: true }])
  })

  it("says nothing when the comment is all there is", async () => {
    const { imports, errors } = await parse("const m = import(/* nothing here */)")

    // No specifier was written, so there is no edge — and no complaint either. The empty
    // specifier is the case where someone typed a module name that names nothing, and
    // nobody typed one here.
    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })
})

describe("LP26j: a template specifier with nothing substituted into it", () => {
  it("is read as the static specifier it is", async () => {
    const { imports, errors } = await parse("const m = import(`./mod`)")

    expect(imports).toEqual([{ source: "./mod", symbols: "*", line: 1, dynamic: true }])
    expect(errors).toEqual([])
  })

  it("LP26a: reports an empty one, the way an empty quoted specifier is reported", async () => {
    const { imports, errors } = await parse("const m = import(``)")

    expect(imports).toEqual([])
    expect(emptySpecifierErrors(errors)).toEqual([
      {
        message:
          "empty module specifier: this dynamic import names no module — write one, or remove the dynamic import",
        line: 1,
        column: 18,
        recoverable: true,
      },
    ])
  })
})

describe("LP26e: a template the author computes stays computed", () => {
  it.each([
    ["a trailing substitution", `const m = import(\`./\${p}\`)`],
    ["a substitution in the middle", `const m = import(\`./a\${p}/b\`)`],
    ["a leading substitution", `const m = import(\`\${dir}/b\`)`],
    ["nothing but a substitution", `const m = import(\`\${p}\`)`],
  ])("gives no edge and no diagnostic for %s", async (_label, source) => {
    const { imports, errors } = await parse(source)

    // The failure this pins is not the missing edge — it is the plausible one. Joining the
    // fragments answers "./", "./a/b" and "/b" for the first three, each a module the author
    // did not write: the first two are relative and can resolve to a real file in the right
    // tree, and the third is an absolute-looking specifier that would be filed as a package.
    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })
})
