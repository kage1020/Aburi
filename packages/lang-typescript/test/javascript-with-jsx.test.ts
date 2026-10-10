import { describe, expect, it } from "vitest"
import { callsOf, parseErrorsOf, parseSource, requireTree, symbolsOf } from "./fixtures/ctx"

const NEXT_APP_TEMPLATE = [
  'import "./globals.css"',
  "",
  "export default function RootLayout({ children }) {",
  "  return (",
  '    <html lang="en">',
  "      <body>{children}</body>",
  "    </html>",
  "  )",
  "}",
  "",
].join("\n")

const HANDLER_IN_JSX = [
  "export function Page() {",
  "  const c = useData()",
  "  return <main onClick={() => track(c)}>{fmt(c)}</main>",
  "}",
  "",
].join("\n")

async function treeOf(path: string, content: string): Promise<string> {
  const result = await parseSource(content, path)
  return requireTree(result.tree).rootNode.toString()
}

describe("a JavaScript file containing JSX", () => {
  it.each([
    "app/layout.js",
    "app/layout.mjs",
    "app/layout.cjs",
    "app/layout.jsx",
  ])("parses %s", async (path) => {
    expect(await parseErrorsOf(NEXT_APP_TEMPLATE, path)).toEqual([])
  })

  it("extracts the component the file declares", async () => {
    const symbols = await symbolsOf(NEXT_APP_TEMPLATE, "app/layout.js")
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([["RootLayout", "function"]])
  })

  it("walks the calls written inside the markup", async () => {
    expect(await parseErrorsOf(HANDLER_IN_JSX, "app/page.js")).toEqual([])
    expect(await callsOf(HANDLER_IN_JSX, "ts:app/page.js#Page", "app/page.js")).toEqual([
      "useData",
      "track",
      "fmt",
    ])
    expect(await callsOf(HANDLER_IN_JSX, "ts:app/page.ts#Page", "app/page.ts")).toEqual(["useData"])
  })
})

describe("the two grammars agree about everything that is not JSX", () => {
  const SHAPES: [string, string, string][] = [
    ["a comparison run", "src/a.js", "export const r = (a < b, c > (d))"],
    ["a generic-looking call", "src/a.js", "export const r = a<b>(c)"],
    ["a bare less-greater", "src/a.js", "export const r = a < b > c"],
    ["a generic constructor", "src/a.js", "export const m = new Map<string, number>()"],
    ["import.meta", "src/a.mjs", "export const u = import.meta.url"],
    ["a namespace re-export", "src/a.mjs", 'export * as ns from "./m"'],
    ["top-level await", "src/a.mjs", "const x = await import('./m')"],
    ["import attributes", "src/a.mjs", "const x = await import('./m', { with: { type: 'json' } })"],
    ["commonjs exports", "src/a.cjs", "exports.a = 1; module.exports.b = 2"],
    ["a hashbang", "src/a.cjs", "#!/usr/bin/env node\nconsole.log(1)"],
    ["private members", "src/a.js", "class C { #m() {} static #s = 1; has(o) { return #m in o } }"],
    ["a regex holding a less-than", "src/a.js", "export const r = /a<b/.test(s)"],
    ["a tagged template", "src/a.js", `export const r = tag\`a\${b}c\``],
  ]

  it.each(SHAPES)("reads %s the same either way", async (_label, path, source) => {
    expect(await treeOf(path, source)).toBe(await treeOf("src/a.ts", source))
    expect(await parseErrorsOf(source, path)).toEqual([])
  })
})

describe("the old-style type assertion decides which extension goes where", () => {
  const ASSERTION = "const a = <Handler>(() => 1)"

  it.each(["src/a.ts", "src/a.mts", "src/a.cts"])("is a type assertion in %s", async (path) => {
    expect(await parseErrorsOf(ASSERTION, path)).toEqual([])
    expect(await treeOf(path, ASSERTION)).toContain("type_assertion")
  })

  it.each(["src/a.js", "src/a.mjs", "src/a.cjs"])("is not one in %s", async (path) => {
    expect(await parseErrorsOf(ASSERTION, path)).not.toEqual([])
    expect(await treeOf(path, ASSERTION)).not.toContain("type_assertion")
  })
})
