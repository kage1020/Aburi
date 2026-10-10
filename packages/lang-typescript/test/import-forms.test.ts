import { describe, expect, it } from "vitest"
import { importsOf } from "./fixtures/ctx"

describe("LP26f: import-equals-require binds the module object", () => {
  it("produces a namespace edge carrying the local binding", async () => {
    const { imports, errors } = await importsOf("import x = require('./mod')")

    // The whole edge, not its presence. The shape is the point: `symbols: "*"` with a
    // `namespaceBinding` is what sends `x.foo()` to `foo` in the target file, where a
    // default binding (`symbols: ["default as x"]`) would send it to a member `foo` of the
    // target's default export instead. `import x = require(...)` binds the module object, as
    // `import * as x` does.
    expect(imports).toEqual([
      { source: "./mod", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x" },
    ])
    expect(errors).toEqual([])
  })

  it("is a static edge, which is what makes it reachable by call resolution", async () => {
    const { imports } = await importsOf("import x = require('./mod')")

    expect(imports[0]?.dynamic).toBe(false)
  })

  it("LP26g: reads a type-only require-equals on the same terms", async () => {
    const { imports } = await importsOf("import type x = require('./mod')")

    expect(imports).toEqual([
      { source: "./mod", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x" },
    ])
  })

  it("reads it under the CommonJS extension it is the ordinary form for", async () => {
    const { imports } = await importsOf("import x = require('./mod')", "src/a.cts")

    expect(imports).toEqual([
      { source: "./mod", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x" },
    ])
  })

  it("LP26h: says nothing about an alias that renames a local namespace", async () => {
    const { imports, errors } = await importsOf("import x = A.B.C")

    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })

  it.each([
    ["a concatenation whose first operand is a literal", `import x = require("a" + b)`],
    ["a concatenation whose second operand is a literal", `import x = require(b + "./real")`],
    ["a second argument", "import x = require('./m', 'y')"],
    ["a nested call", "import x = require(f('./m'))"],
  ])("refuses a clause that did not parse — %s", async (_label, source) => {
    const { imports, errors } = await importsOf(source)

    expect(imports).toEqual([])
    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
  })

  it("keeps a require-equals beside an ordinary import, in source order", async () => {
    const { imports } = await importsOf("import { A } from './a'\nimport b = require('./b')")

    expect(imports).toEqual([
      { source: "./a", symbols: ["A"], line: 1, dynamic: false },
      { source: "./b", symbols: "*", line: 2, dynamic: false, namespaceBinding: "b" },
    ])
  })
})

describe("LP26i: a comment among the arguments of import()", () => {
  it("reads the specifier past a webpack magic comment", async () => {
    const { imports, errors } = await importsOf(
      'const m = import(/* webpackChunkName: "x" */ "./mod")',
    )

    expect(imports).toEqual([{ source: "./mod", symbols: "*", line: 1, dynamic: true }])
    expect(errors).toEqual([])
  })

  it("reads past two of them", async () => {
    const { imports } = await importsOf("const m = import(/* a */ /* b */ './mod')")

    expect(imports).toEqual([{ source: "./mod", symbols: "*", line: 1, dynamic: true }])
  })

  it("says nothing when the comment is all there is", async () => {
    const { imports, errors } = await importsOf("const m = import(/* nothing here */)")

    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })
})

describe("LP26j: a template specifier with nothing substituted into it", () => {
  it("is read as the static specifier it is", async () => {
    const { imports, errors } = await importsOf("const m = import(`./mod`)")

    expect(imports).toEqual([{ source: "./mod", symbols: "*", line: 1, dynamic: true }])
    expect(errors).toEqual([])
  })
})

describe("LP26e: a template the author computes stays computed", () => {
  it.each([
    ["a trailing substitution", `const m = import(\`./\${p}\`)`],
    ["a substitution in the middle", `const m = import(\`./a\${p}/b\`)`],
    ["a leading substitution", `const m = import(\`\${dir}/b\`)`],
    ["nothing but a substitution", `const m = import(\`\${p}\`)`],
  ])("gives no edge and no diagnostic for %s", async (_label, source) => {
    const { imports, errors } = await importsOf(source)

    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })
})
