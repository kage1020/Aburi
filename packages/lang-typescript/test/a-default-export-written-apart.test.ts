import { describe, expect, it } from "vitest"
import { symbolOf, symbolsOf } from "./fixtures/ctx"

const TSX = "src/a.tsx"

const PAGE = "ts:src/a.tsx#Page"

/** A bare `export default` of something else, so a negative fixture reaches the matching pass. */
const ANCHOR = "const Anchor = () => null\nexport default Anchor\n"

describe("a default export written apart from its declaration", () => {
  it.each([
    ["an arrow assigned to a const", "const Page = () => null\nexport default Page\n"],
    ["a function declaration", "function Page() { return null }\nexport default Page\n"],
    ["a class declaration", "class Page {}\nexport default Page\n"],
    ["a plain const", "const Page = 1\nexport default Page\n"],
    ["a declaration written after the export", "export default Page\nfunction Page() {}\n"],
    ["a parenthesized name", "const Page = () => null\nexport default (Page)\n"],
    ["a name behind `as`", "const Page = () => null\nexport default Page as FC\n"],
    ["a name behind `satisfies`", "const Page = () => null\nexport default Page satisfies FC\n"],
    ["a name behind a non-null assertion", "const Page = () => null\nexport default Page!\n"],
    ["a name behind nested wrappers", "const Page = () => null\nexport default ((Page as FC)!)\n"],
  ])("reaches %s", async (_label, source) => {
    const page = await symbolOf(source, PAGE, TSX)

    expect(page.derivedBy).toContain("export-default")
    expect(page.visibility).toBe("public")
  })

  it.each([
    [
      "keeps the evidence the declaration carried",
      "const Page = () => null\nexport default Page\n",
      ["variable-assigned-function", "export-default"],
    ],
    [
      "records both exports when the declaration is also named-exported",
      "export const Page = () => null\nexport default Page\n",
      ["variable-assigned-function", "export-keyword", "export-default"],
    ],
    [
      "says export-default once when a second export default names the same declaration",
      "export default function Page() {}\nexport default Page\n",
      ["export-default"],
    ],
  ])("%s", async (_label, source, derivedBy) => {
    expect((await symbolOf(source, PAGE, TSX)).derivedBy).toEqual(derivedBy)
  })

  it("leaves the other declarations in the file internal", async () => {
    const helper = await symbolOf(
      "const helper = () => null\nconst Page = () => helper()\nexport default Page\n",
      "ts:src/a.tsx#helper",
      TSX,
    )

    expect([helper.visibility, helper.derivedBy]).toEqual([
      "internal",
      ["variable-assigned-function"],
    ])
  })

  it.each([
    [
      "a value the module computes",
      `${ANCHOR}const Page = () => null\nexport default withAuth(Page)\n`,
      PAGE,
    ],
    [
      "an object literal that mentions it",
      `${ANCHOR}const Page = () => null\nexport default { Page }\n`,
      PAGE,
    ],
    [
      "a namespaced declaration through a member expression",
      "namespace Routes { export const Page = () => null }\nexport default Routes.Page\n",
      "ts:src/a.tsx#Routes.Page",
    ],
    [
      "a class member through a member expression",
      "class Shell { Page() {} }\nexport default Shell.Page\n",
      "ts:src/a.tsx#Shell.Page",
    ],
    [
      "a class member that shares a bare identifier's spelling",
      "class Shell { Page() {} }\nexport default Page\n",
      "ts:src/a.tsx#Shell.Page",
    ],
    [
      "a call Symbol whose qname the export happens to spell",
      "const app = 1\napp.get('/x', () => {})\nexport default app__get__$x__d0\n",
      "ts:src/a.tsx#app__get__$x__d0",
    ],
  ])("does not read %s as the default export", async (_label, source, id) => {
    expect((await symbolOf(source, id, TSX)).derivedBy).not.toContain("export-default")
  })

  it("declares nothing for an identifier that names an import", async () => {
    const symbols = await symbolsOf("import Page from './page'\nexport default Page\n", TSX)

    expect(symbols.map((s) => s.name)).not.toContain("Page")
  })
})
