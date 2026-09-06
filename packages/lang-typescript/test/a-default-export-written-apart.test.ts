import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, parseTypescriptFile } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * `export default Page` written beside the declaration instead of in front of it.
 *
 * The declaration node says nothing about the export — its parent is the module — so a walk
 * that reads the parent finds no default export in the file at all, and the Symbol reported
 * itself `internal` with no `export-default`. The two are the signals a framework plugin reads
 * to find the page, layout or component a file exports, and `const Page = () => …; export
 * default Page` is one of the two ordinary ways to write one.
 */

async function symbolsOf(source: string, path = "src/a.tsx"): Promise<SymbolCandidate<Node>[]> {
  const result = await parseTypescriptFile({ path, content: source })
  return extractSymbols(requireTree(result.tree), makeExtractionCtx(path, source))
}

async function symbolNamed(source: string, name: string): Promise<SymbolCandidate<Node>> {
  const symbols = await symbolsOf(source)
  const found = symbols.find((s) => s.name === name)
  if (found === undefined) {
    throw new Error(`no Symbol named ${name}; have ${symbols.map((s) => s.name).join(", ")}`)
  }
  return found
}

describe("a default export written apart from its declaration", () => {
  const FORMS: [string, string][] = [
    ["an arrow assigned to a const", "const Page = () => null\nexport default Page\n"],
    ["a function declaration", "function Page() { return null }\nexport default Page\n"],
    ["a class declaration", "class Page {}\nexport default Page\n"],
    ["a plain const", "const Page = 1\nexport default Page\n"],
    ["a declaration written after the export", "export default Page\nfunction Page() {}\n"],
  ]

  it.each(FORMS)("reaches %s", async (_label, source) => {
    const sym = await symbolNamed(source, "Page")
    expect(sym.derivedBy).toContain("export-default")
    expect(sym.visibility).toBe("public")
  })

  it("keeps the evidence the declaration carried", async () => {
    const sym = await symbolNamed("const Page = () => null\nexport default Page\n", "Page")
    expect(sym.derivedBy).toEqual(["variable-assigned-function", "export-default"])
    expect(sym.kind).toBe("function")
  })

  it("records both exports when the declaration is also named-exported", async () => {
    const sym = await symbolNamed("export const Page = () => null\nexport default Page\n", "Page")
    expect(sym.derivedBy).toEqual([
      "variable-assigned-function",
      "export-keyword",
      "export-default",
    ])
  })

  it("says export-default once when the declaration already wore it", async () => {
    const sym = await symbolNamed("export default function Page() {}\n", "Page")
    expect(sym.derivedBy.filter((d) => d === "export-default")).toHaveLength(1)
  })

  it("leaves the other declarations in the file internal", async () => {
    const symbols = await symbolsOf(
      "const helper = () => null\nconst Page = () => helper()\nexport default Page\n",
    )
    const helper = symbols.find((s) => s.name === "helper")
    expect(helper?.visibility).toBe("internal")
    expect(helper?.derivedBy).not.toContain("export-default")
  })

  it("does not read a value the module computes as a declaration", async () => {
    const sym = await symbolNamed(
      "const Page = () => null\nexport default withAuth(Page)\n",
      "Page",
    )
    expect(sym.visibility).toBe("internal")
    expect(sym.derivedBy).not.toContain("export-default")
  })

  it("does not reach a class member that shares the identifier's spelling", async () => {
    // A member is `public` to the type checker with no modifier written, so the visibility
    // says nothing here; `export-default` is the signal that would be wrong.
    const symbols = await symbolsOf("class Shell { Page() {} }\nexport default Page\n")
    const member = symbols.find((s) => s.name === "Shell.Page")
    expect(member).toBeDefined()
    expect(member?.derivedBy).not.toContain("export-default")
  })

  it("does not reach a namespaced declaration of the same leaf name", async () => {
    const symbols = await symbolsOf("namespace Routes { export const Page = () => null }\n")
    const nested = symbols.find((s) => s.name === "Routes.Page")
    expect(nested?.derivedBy).not.toContain("export-default")
  })

  it("declares nothing for an identifier that names an import", async () => {
    const symbols = await symbolsOf("import Page from './page'\nexport default Page\n")
    expect(symbols.map((s) => s.name)).not.toContain("Page")
  })
})
