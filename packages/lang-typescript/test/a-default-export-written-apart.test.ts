import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, parseTypescriptFile } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * LP6a — `export default Page` written beside the declaration instead of in front of it.
 *
 * The declaration node says nothing about the export — its parent is the module — so a walk
 * that reads the parent finds no default export in the file at all, and the Symbol reported
 * itself `internal` with no `export-default`. The two are the signals a framework plugin reads
 * to find the page, layout or component a file exports, and `const Page = () => …; export
 * default Page` is one of the two ordinary ways to write one.
 *
 * Every case that must **not** link back is written with a bare default export beside it, so
 * the fixture reaches the matching pass rather than stopping at its empty-name-set return —
 * a negative that never runs the code it names proves nothing about it.
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

/** A bare `export default` of something else, so a negative fixture reaches the matching pass. */
const ANCHOR = "const Anchor = () => null\nexport default Anchor\n"

describe("LP6a: a default export written apart from its declaration", () => {
  const FORMS: [string, string][] = [
    ["an arrow assigned to a const", "const Page = () => null\nexport default Page\n"],
    ["a function declaration", "function Page() { return null }\nexport default Page\n"],
    ["a class declaration", "class Page {}\nexport default Page\n"],
    ["a plain const", "const Page = 1\nexport default Page\n"],
    ["a declaration written after the export", "export default Page\nfunction Page() {}\n"],
  ]

  it.each(FORMS)("LP6a: reaches %s", async (_label, source) => {
    const sym = await symbolNamed(source, "Page")
    expect(sym.derivedBy).toContain("export-default")
    expect(sym.visibility).toBe("public")
  })

  // LP7a: one reader answers what a wrapper is. A `satisfies`, an `as`, a `!` and a
  // parenthesis all leave the value the declaration it names, and `export default Page
  // satisfies NextPage` is an ordinary spelling — LP6a's promise is that the framework does
  // not depend on which of them was written.
  const WRAPPERS: [string, string][] = [
    ["a parenthesis", "(Page)"],
    ["an `as`", "Page as FC"],
    ["a `satisfies`", "Page satisfies FC"],
    ["a non-null assertion", "Page!"],
    ["wrappers nested", "((Page as FC)!)"],
  ]

  it.each(WRAPPERS)("LP6a/LP7a: reads through %s", async (_label, written) => {
    const sym = await symbolNamed(`const Page = () => null\nexport default ${written}\n`, "Page")
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

  it("says export-default once when a second export default names the same declaration", async () => {
    // TS2528 — invalid source the grammar still hands over. The wrapped spelling already
    // carries the tag, and the matching pass must not add a duplicate to it. This is the only
    // input that reaches that guard: a legal module writing `export default function Page()`
    // leaves no `value` field to collect a name from.
    const sym = await symbolNamed(
      "export default function Page() {}\nexport default Page\n",
      "Page",
    )
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
    // LP7b: a call returns a value by convention and nothing in the tree says so, so the
    // unwrap stops here. The anchor keeps the name set non-empty so the matching pass runs.
    const sym = await symbolNamed(
      `${ANCHOR}const Page = () => null\nexport default withAuth(Page)\n`,
      "Page",
    )
    expect(sym.visibility).toBe("internal")
    expect(sym.derivedBy).not.toContain("export-default")
  })

  it("does not read an object literal that mentions the declaration", async () => {
    const sym = await symbolNamed(
      `${ANCHOR}const Page = () => null\nexport default { Page }\n`,
      "Page",
    )
    expect(sym.derivedBy).not.toContain("export-default")
  })

  it("does not reach a namespaced declaration through a member expression", async () => {
    // `Routes.Page` is a member_expression whose text spells the nested qname exactly, so
    // reading the value's text rather than requiring an identifier would promote it.
    const symbols = await symbolsOf(
      "namespace Routes { export const Page = () => null }\nexport default Routes.Page\n",
    )
    const nested = symbols.find((s) => s.name === "Routes.Page")
    expect(nested).toBeDefined()
    expect(nested?.derivedBy).not.toContain("export-default")
  })

  it("does not reach a class member through a member expression", async () => {
    const symbols = await symbolsOf("class Shell { Page() {} }\nexport default Shell.Page\n")
    const member = symbols.find((s) => s.name === "Shell.Page")
    expect(member).toBeDefined()
    expect(member?.derivedBy).not.toContain("export-default")
  })

  it("does not reach a class member that shares a bare identifier's spelling", async () => {
    // The separator is what keeps `Shell.Page` out of reach of the name `Page`.
    const symbols = await symbolsOf("class Shell { Page() {} }\nexport default Page\n")
    const member = symbols.find((s) => s.name === "Shell.Page")
    expect(member).toBeDefined()
    expect(member?.derivedBy).not.toContain("export-default")
  })

  it("does not reach a call Symbol whose qname the export happens to spell", async () => {
    // LP20g qnames are a single identifier-legal segment, so the separator argument does not
    // cover them. A registration statement is not a declaration an export can be naming.
    const registration = "const app = 1\napp.get('/x', () => {})\n"
    const symbols = await symbolsOf(registration)
    const call = symbols.find((s) => s.kind === "call")
    if (call === undefined) throw new Error("fixture declares no call Symbol")
    const promoted = await symbolsOf(`${registration}export default ${call.name}\n`)
    const same = promoted.find((s) => s.name === call.name)
    expect(same?.derivedBy).not.toContain("export-default")
    expect(same?.visibility).toBe(call.visibility)
  })

  it("declares nothing for an identifier that names an import", async () => {
    // A pin on `visitStatement`, not on the matching pass: the pass is a map and can never
    // create a candidate. If imports ever become candidates, this is what says so.
    const symbols = await symbolsOf("import Page from './page'\nexport default Page\n")
    expect(symbols.map((s) => s.name)).not.toContain("Page")
  })
})
