import type { WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { TYPESCRIPT_FILE_EXTENSIONS, walkBody } from "../src/index"
import { makeExtractionCtx, parseSource, requireTree, symbolsOf } from "./fixtures/ctx"

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

async function errorsOf(path: string, content: string): Promise<string[]> {
  const result = await parseSource(content, path)
  return result.errors.map((e) => `${e.line}:${e.column} ${e.message}`)
}

async function treeOf(path: string, content: string): Promise<string> {
  const result = await parseSource(content, path)
  return requireTree(result.tree).rootNode.toString()
}

async function callsByNameOf(path: string, content: string, name: string): Promise<string[]> {
  const target = (await symbolsOf(content, path)).find((s) => s.name === name)
  if (target === undefined) throw new Error(`no Symbol ${name} in fixture`)
  const walkCtx: WalkContext<Node> = { ...makeExtractionCtx(path, content), symbol: target }
  return walkBody(target, walkCtx).calls.map((c) => c.target)
}

describe("a JavaScript file containing JSX", () => {
  it.each([
    "app/layout.js",
    "app/layout.mjs",
    "app/layout.cjs",
    "app/layout.jsx",
  ])("parses %s", async (path) => {
    expect(await errorsOf(path, NEXT_APP_TEMPLATE)).toEqual([])
  })

  it("extracts the component the file declares", async () => {
    // A named default export keeps its written name; `<default>` is for the anonymous form.
    const symbols = await symbolsOf(NEXT_APP_TEMPLATE, "app/layout.js")
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([["RootLayout", "function"]])
  })

  it("walks the calls written inside the markup", async () => {
    expect(await errorsOf("app/page.js", HANDLER_IN_JSX)).toEqual([])
    expect(await callsByNameOf("app/page.js", HANDLER_IN_JSX, "Page")).toEqual([
      "useData",
      "track",
      "fmt",
    ])
    expect(await callsByNameOf("app/page.ts", HANDLER_IN_JSX, "Page")).toEqual(["useData"])
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
    expect(await errorsOf(path, source)).toEqual([])
  })
})

describe("the old-style type assertion decides which extension goes where", () => {
  const ASSERTION = "const a = <Handler>(() => 1)"

  it.each(["src/a.ts", "src/a.mts", "src/a.cts"])("is a type assertion in %s", async (path) => {
    expect(await errorsOf(path, ASSERTION)).toEqual([])
    expect(await treeOf(path, ASSERTION)).toContain("type_assertion")
  })

  it.each(["src/a.js", "src/a.mjs", "src/a.cjs"])("is not one in %s", async (path) => {
    expect(await errorsOf(path, ASSERTION)).not.toEqual([])
    expect(await treeOf(path, ASSERTION)).not.toContain("type_assertion")
  })
})

describe("the extension list is still the grammar map's", () => {
  it("names every extension this plugin claims", () => {
    expect([...TYPESCRIPT_FILE_EXTENSIONS].sort()).toEqual([
      ".cjs",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".mts",
      ".ts",
      ".tsx",
    ])
  })
})
