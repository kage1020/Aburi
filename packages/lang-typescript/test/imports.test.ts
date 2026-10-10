import { describe, expect, it } from "vitest"
import { importsOf } from "./fixtures/ctx"

describe("the edge an import statement makes", () => {
  it.each([
    ["a named import", "import { X } from './y'", [{ source: "./y", symbols: ["X"] }]],
    [
      "an aliased named import",
      "import { A as B } from './x'",
      [{ source: "./x", symbols: ["A as B"] }],
    ],
    ["a type-only import", "import type { X } from './y'", [{ source: "./y", symbols: ["X"] }]],
    [
      "a default import, as the module's `default` under its local name",
      "import Foo from './foo'",
      [{ source: "./foo", symbols: ["default as Foo"] }],
    ],
    [
      "`{ default as Foo }`, spelled as `import Foo` is",
      "import { default as Foo } from './foo'",
      [{ source: "./foo", symbols: ["default as Foo"] }],
    ],
    [
      "a default import beside named ones",
      "import Foo, { A, B } from './x'",
      [{ source: "./x", symbols: ["default as Foo", "A", "B"] }],
    ],
    [
      "a namespace import",
      "import * as Y from 'z'",
      [{ source: "z", symbols: "*", namespaceBinding: "Y" }],
    ],
    [
      "a default import beside a namespace one, as one edge each",
      "import Foo, * as Bar from './x'",
      [
        { source: "./x", symbols: ["default as Foo"] },
        { source: "./x", symbols: "*", namespaceBinding: "Bar" },
      ],
    ],
    [
      "a bare side-effect import",
      "import './side-effect'",
      [{ source: "./side-effect", symbols: "*" }],
    ],
    ["a re-export", "export { X } from './y'", [{ source: "./y", symbols: ["X"] }]],
  ])("reads %s", async (_label, source, edges) => {
    const { imports } = await importsOf(source)

    expect(imports).toEqual(edges.map((edge) => ({ ...edge, line: 1, dynamic: false })))
  })

  it("reads a dynamic import() anywhere in the file", async () => {
    const { imports } = await importsOf("async function f(){ return await import('./x') }")

    expect(imports).toEqual([{ source: "./x", symbols: "*", line: 1, dynamic: true }])
  })

  it("puts the edges in source order, whichever pass found them", async () => {
    const { imports } = await importsOf("const m = import('./a')\nimport { B } from './b'")

    expect(imports).toEqual([
      { source: "./a", symbols: "*", line: 1, dynamic: true },
      { source: "./b", symbols: ["B"], line: 2, dynamic: false },
    ])
  })
})

describe("two imports of one module on one line", () => {
  it("collapse into one edge when they name the same symbols in another order", async () => {
    const { imports } = await importsOf("import { A, B } from './x'; import { B, A } from './x'")

    expect(imports).toEqual([{ source: "./x", symbols: ["A", "B"], line: 1, dynamic: false }])
  })

  it.each([
    [
      "a static and a dynamic one",
      "import './x'; const m = import('./x')",
      [
        { source: "./x", symbols: "*", line: 1, dynamic: false },
        { source: "./x", symbols: "*", line: 1, dynamic: true },
      ],
    ],
    [
      "two namespace imports under different names",
      "import * as A from './x'; import * as B from './x'",
      [
        { source: "./x", symbols: "*", line: 1, dynamic: false, namespaceBinding: "A" },
        { source: "./x", symbols: "*", line: 1, dynamic: false, namespaceBinding: "B" },
      ],
    ],
    [
      "a side-effect import and a namespace one",
      "import './x'; import * as N from './x'",
      [
        { source: "./x", symbols: "*", line: 1, dynamic: false },
        { source: "./x", symbols: "*", line: 1, dynamic: false, namespaceBinding: "N" },
      ],
    ],
  ])("stay apart as %s", async (_label, source, edges) => {
    expect((await importsOf(source)).imports).toEqual(edges)
  })

  it("stay apart when they are written on two lines", async () => {
    const { imports } = await importsOf("import { A } from './x'\nimport { A } from './x'")

    expect(imports.map((e) => e.line)).toEqual([1, 2])
  })
})
