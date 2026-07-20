import { parseTypescriptFile } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { findFirstJsxElementName, hasJsxReturn, isProviderElementName } from "../src/index"

/**
 * Parse a TSX source and return the root node so tests can hand a real tree-sitter node
 * to the JSX walkers. Tests exercise the walkers against genuine grammar output rather
 * than fabricating node shapes — the walkers duck-type on the tree-sitter node surface,
 * so drifting from the actual shape would produce false-passing tests.
 */
async function parseRoot(source: string): Promise<unknown> {
  const result = await parseTypescriptFile({ path: "src/f.tsx", content: source })
  if (result.tree === null) throw new Error("parse returned null")
  return result.tree.rootNode
}

describe("hasJsxReturn", () => {
  it("returns false for null (no body)", () => {
    expect(hasJsxReturn(null)).toBe(false)
  })

  it("returns false for a plain function that returns a literal", async () => {
    const root = await parseRoot("function f() { return 42 }")
    expect(hasJsxReturn(root)).toBe(false)
  })

  it("returns true when the body contains a jsx_element", async () => {
    const root = await parseRoot("function C() { return <div>hi</div> }")
    expect(hasJsxReturn(root)).toBe(true)
  })

  it("returns true when the body contains a jsx_self_closing_element", async () => {
    const root = await parseRoot("function C() { return <br /> }")
    expect(hasJsxReturn(root)).toBe(true)
  })

  it("returns true when the body contains a jsx_fragment", async () => {
    const root = await parseRoot("function C() { return <>hi</> }")
    expect(hasJsxReturn(root)).toBe(true)
  })

  it("returns true when JSX is nested inside a conditional", async () => {
    const root = await parseRoot("function C(x) { if (x) return <p /> ; return null }")
    expect(hasJsxReturn(root)).toBe(true)
  })

  it("returns false for a body-less value (non-syntax-node input)", () => {
    // Ducks a lang plugin that hands us a non-tree-sitter shape — the walker must not
    // blow up, it must just return false.
    expect(hasJsxReturn({ placeholder: true } as unknown as null)).toBe(false)
  })
})

describe("findFirstJsxElementName", () => {
  it("returns null for a JSX-less body", async () => {
    const root = await parseRoot("function f() { return 1 }")
    expect(findFirstJsxElementName(root)).toBeNull()
  })

  it("returns the plain identifier name of a self-closing element", async () => {
    const root = await parseRoot("function C() { return <Widget /> }")
    expect(findFirstJsxElementName(root)).toBe("Widget")
  })

  it("returns the member expression text for a namespaced element", async () => {
    const root = await parseRoot(
      "function C() { return <MyContext.Provider>x</MyContext.Provider> }",
    )
    expect(findFirstJsxElementName(root)).toBe("MyContext.Provider")
  })

  it("returns an empty string for a fragment", async () => {
    const root = await parseRoot("function C() { return <>x</> }")
    expect(findFirstJsxElementName(root)).toBe("")
  })
})

describe("isProviderElementName", () => {
  it("accepts member expressions ending in .Provider", () => {
    expect(isProviderElementName("MyContext.Provider")).toBe(true)
    expect(isProviderElementName("foo.bar.Provider")).toBe(true)
  })

  it("rejects a plain Provider identifier (ambiguous with a component named Provider)", () => {
    expect(isProviderElementName("Provider")).toBe(false)
  })

  it("rejects non-Provider tails", () => {
    expect(isProviderElementName("MyContext.Consumer")).toBe(false)
    expect(isProviderElementName("div")).toBe(false)
  })

  it("rejects the empty string (fragment shape)", () => {
    expect(isProviderElementName("")).toBe(false)
  })
})
