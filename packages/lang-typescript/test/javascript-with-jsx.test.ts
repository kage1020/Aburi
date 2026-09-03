import type { WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import {
  extractSymbols,
  parseTypescriptFile,
  TYPESCRIPT_FILE_EXTENSIONS,
  walkBody,
} from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * The JavaScript extensions are covered so `framework-react` can classify React sources in
 * plain-JavaScript codebases. A React source written in `.js` contains JSX in `.js` — which is
 * what `create-next-app`'s JavaScript template emits and what CRA emitted.
 *
 * A grammar that refuses JSX recovers past it rather than failing, so what is lost is not
 * usually the declaration: it is everything inside the markup, and a clean parse-error count.
 *
 * The only thing the tsx grammar refuses that the TypeScript grammar accepts is the old-style
 * type assertion `<T>expr`, which is TypeScript and was never JavaScript. That is why the
 * TypeScript extensions stay where they are and the JavaScript ones move, and it is pinned from
 * both directions below.
 */

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
  const result = await parseTypescriptFile({ path, content })
  return result.errors.map((e) => `${e.line}:${e.column} ${e.message}`)
}

async function treeOf(path: string, content: string): Promise<string> {
  const result = await parseTypescriptFile({ path, content })
  return requireTree(result.tree).rootNode.toString()
}

async function symbolsOf(path: string, content: string): Promise<[string, string][]> {
  const result = await parseTypescriptFile({ path, content })
  const ctx = makeExtractionCtx(path, content)
  return extractSymbols(requireTree(result.tree), ctx).map((s) => [s.name, s.kind])
}

async function callsOf(path: string, content: string, name: string): Promise<string[]> {
  const result = await parseTypescriptFile({ path, content })
  const ctx = makeExtractionCtx(path, content)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.name === name)
  if (target === undefined) throw new Error(`no Symbol ${name} in fixture`)
  const walkCtx: WalkContext<Node> = { ...ctx, symbol: target }
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
    expect(await symbolsOf("app/layout.js", NEXT_APP_TEMPLATE)).toEqual([
      ["RootLayout", "function"],
    ])
  })

  it("walks the calls written inside the markup", async () => {
    // What a refusing grammar actually costs. It is not usually the declaration — recovery
    // salvages that — it is everything from the first tag onwards: a handler's call and an
    // interpolated one end up in no Symbol at all. The `.ts` row reads the same source with
    // the grammar `.js` used to get.
    expect(await errorsOf("app/page.js", HANDLER_IN_JSX)).toEqual([])
    expect(await callsOf("app/page.js", HANDLER_IN_JSX, "Page")).toEqual([
      "useData",
      "track",
      "fmt",
    ])
    expect(await callsOf("app/page.ts", HANDLER_IN_JSX, "Page")).toEqual(["useData"])
  })
})

describe("the two grammars agree about everything that is not JSX", () => {
  // A `.ts` path still uses the TypeScript grammar, so each row is one source read by both.
  // This pins the *cost* of the move, not the routing: every row is identical under either
  // grammar, so it would pass with `.js` routed back. What holds the routing is the
  // type-assertion block below.
  //
  // The rows are the shapes where a JSX-aware grammar could plausibly disagree — the `<`
  // ambiguity — plus the module and class syntax a JavaScript file is most likely to carry,
  // each on the extension it is actually written in.
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
    // The whole cost of the move, and the only thing holding the TypeScript extensions in
    // place. `<T>expr` is not JavaScript — the TypeScript grammar was accepting it in a `.js`
    // file only because that file was being read as TypeScript.
    expect(await errorsOf(path, ASSERTION)).not.toEqual([])
    expect(await treeOf(path, ASSERTION)).not.toContain("type_assertion")
  })
})

describe("the extension list is still the map's", () => {
  it("names every extension this plugin claims", async () => {
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
