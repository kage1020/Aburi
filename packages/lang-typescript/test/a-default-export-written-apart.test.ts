import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { symbolsOf } from "./fixtures/ctx"

const TSX = "src/a.tsx"

async function symbolNamed(source: string, name: string): Promise<SymbolCandidate<Node>> {
  const symbols = await symbolsOf(source, TSX)
  const found = symbols.find((s) => s.name === name)
  if (found === undefined) {
    throw new Error(`no Symbol named ${name}; have ${symbols.map((s) => s.name).join(", ")}`)
  }
  return found
}

/** A bare `export default` of something else, so a negative fixture reaches the matching pass. */
const ANCHOR = "const Anchor = () => null\nexport default Anchor\n"

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

  const WRAPPERS: [string, string][] = [
    ["a parenthesis", "(Page)"],
    ["an `as`", "Page as FC"],
    ["a `satisfies`", "Page satisfies FC"],
    ["a non-null assertion", "Page!"],
    ["wrappers nested", "((Page as FC)!)"],
  ]

  it.each(WRAPPERS)("reads through %s", async (_label, written) => {
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
    const sym = await symbolNamed(
      "export default function Page() {}\nexport default Page\n",
      "Page",
    )
    expect(sym.derivedBy.filter((d) => d === "export-default")).toHaveLength(1)
  })

  it("leaves the other declarations in the file internal", async () => {
    const symbols = await symbolsOf(
      "const helper = () => null\nconst Page = () => helper()\nexport default Page\n",
      TSX,
    )
    const helper = symbols.find((s) => s.name === "helper")
    expect(helper?.visibility).toBe("internal")
    expect(helper?.derivedBy).not.toContain("export-default")
  })

  it("does not read a value the module computes as a declaration", async () => {
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
    const symbols = await symbolsOf(
      "namespace Routes { export const Page = () => null }\nexport default Routes.Page\n",
      TSX,
    )
    const nested = symbols.find((s) => s.name === "Routes.Page")
    expect(nested).toBeDefined()
    expect(nested?.derivedBy).not.toContain("export-default")
  })

  it("does not reach a class member through a member expression", async () => {
    const symbols = await symbolsOf("class Shell { Page() {} }\nexport default Shell.Page\n", TSX)
    const member = symbols.find((s) => s.name === "Shell.Page")
    expect(member).toBeDefined()
    expect(member?.derivedBy).not.toContain("export-default")
  })

  it("does not reach a class member that shares a bare identifier's spelling", async () => {
    // The separator is what keeps `Shell.Page` out of reach of the name `Page`.
    const symbols = await symbolsOf("class Shell { Page() {} }\nexport default Page\n", TSX)
    const member = symbols.find((s) => s.name === "Shell.Page")
    expect(member).toBeDefined()
    expect(member?.derivedBy).not.toContain("export-default")
  })

  it("does not reach a call Symbol whose qname the export happens to spell", async () => {
    const registration = "const app = 1\napp.get('/x', () => {})\n"
    const symbols = await symbolsOf(registration, TSX)
    const call = symbols.find((s) => s.kind === "call")
    if (call === undefined) throw new Error("fixture declares no call Symbol")
    const promoted = await symbolsOf(`${registration}export default ${call.name}\n`, TSX)
    const same = promoted.find((s) => s.name === call.name)
    expect(same?.derivedBy).not.toContain("export-default")
    expect(same?.visibility).toBe(call.visibility)
  })

  it("declares nothing for an identifier that names an import", async () => {
    const symbols = await symbolsOf("import Page from './page'\nexport default Page\n", TSX)
    expect(symbols.map((s) => s.name)).not.toContain("Page")
  })
})
