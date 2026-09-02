import { describe, expect, it } from "vitest"
import { extractSymbols, parseTypescriptFile, TYPESCRIPT_FILE_EXTENSIONS } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * The JavaScript extensions are covered so `framework-react` can classify React sources in
 * plain-JavaScript codebases. Those sources contain JSX, and outside `.jsx` they contain it in
 * `.js` — which is what `create-next-app`, CRA and Vite emit. Reading them with a grammar that
 * refuses JSX left the component body unparsed.
 *
 * The one construct the two grammars disagree about is the old-style type assertion `<T>expr`,
 * which is TypeScript and was never JavaScript, so the TypeScript extensions stay where they
 * are and the JavaScript ones move.
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

describe("a JavaScript file containing JSX", () => {
  it("parses on every extension a React source is written with", async () => {
    for (const path of ["app/layout.js", "app/layout.mjs", "app/layout.cjs", "app/layout.jsx"]) {
      expect(await errorsOf(path, NEXT_APP_TEMPLATE)).toEqual([])
    }
  })

  it("extracts the component the file declares", async () => {
    // A named default export keeps its written name; `<default>` is for the anonymous form.
    expect(await symbolsOf("app/layout.js", NEXT_APP_TEMPLATE)).toEqual([
      ["RootLayout", "function"],
    ])
  })

  it("walks a body that a refusing grammar swallowed whole", async () => {
    const source = [
      "export function Page() {",
      "  const data = useData()",
      "  return <main onClick={() => track(data)}>{data.title}</main>",
      "}",
      "",
    ].join("\n")

    expect(await errorsOf("app/page.js", source)).toEqual([])
    expect(await symbolsOf("app/page.js", source)).toEqual([["Page", "function"]])
  })
})

describe("plain JavaScript reads the same either way", () => {
  // A `.ts` path still uses the TypeScript grammar, so each row is one source read by both.
  // The rows are the shapes where a JSX-aware grammar could plausibly disagree — the `<`
  // ambiguity — plus the module and class syntax a JavaScript file is most likely to carry.
  const SHAPES: [string, string][] = [
    ["comparison run", "export const r = (a < b, c > (d))"],
    ["generic-looking call", "export const r = a<b>(c)"],
    ["bare less-greater", "export const r = a < b > c"],
    ["generic constructor", "export const m = new Map<string, number>()"],
    ["import.meta", "export const u = import.meta.url"],
    ["namespace re-export", 'export * as ns from "./m"'],
    ["top-level await", "const x = await import('./m')"],
    ["import attributes", "const x = await import('./m', { with: { type: 'json' } })"],
    ["commonjs exports", "exports.a = 1; module.exports.b = 2"],
    ["hashbang", "#!/usr/bin/env node\nconsole.log(1)"],
    ["private members", "class C { #m() {} static #s = 1; has(o) { return #m in o } }"],
    ["regex with a less-than", "export const r = /a<b/.test(s)"],
    ["tagged template", `export const r = tag\`a\${b}c\``],
  ]

  for (const [label, source] of SHAPES) {
    it(`reads ${label} the same in .ts and .js`, async () => {
      expect(await treeOf("src/a.js", source)).toBe(await treeOf("src/a.ts", source))
      expect(await errorsOf("src/a.js", source)).toEqual([])
    })
  }
})

describe("the old-style type assertion stays where it is legal", () => {
  const ASSERTION = "const a = <Handler>(() => 1)"

  it("is a type assertion in every TypeScript extension", async () => {
    for (const path of ["src/a.ts", "src/a.mts", "src/a.cts"]) {
      expect(await errorsOf(path, ASSERTION)).toEqual([])
      expect(await treeOf(path, ASSERTION)).toContain("type_assertion")
    }
  })

  it("is a parse error in a JavaScript file, which is what it is", async () => {
    // The one construct the two grammars disagree about, and the whole cost of the move. It
    // is not JavaScript — the TypeScript grammar was accepting it in a `.js` file by accident.
    for (const path of ["src/a.js", "src/a.mjs", "src/a.cjs"]) {
      expect(await errorsOf(path, ASSERTION)).not.toEqual([])
    }
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
