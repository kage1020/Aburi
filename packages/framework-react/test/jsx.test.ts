import { parseTypescriptFile } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { findReturnedJsxElementName, hasJsxReturn, isProviderElementName } from "../src/index"

/**
 * Parse a TSX source and return the root node. Kept for `hasJsxReturn` tests where the
 * walker is deliberately loose (any JSX descendant counts).
 */
async function parseRoot(source: string): Promise<unknown> {
  const result = await parseTypescriptFile({ path: "src/f.tsx", content: source })
  if (result.tree === null) throw new Error("parse returned null")
  return result.tree.rootNode
}

/**
 * Parse and return the body node of the first `function_declaration` / `arrow_function`
 * found — matches how the plugin uses `symbol.bodyNode` in production (extractSymbols
 * hands the statement_block, not the program root). Provider-detection walkers stop at
 * nested function scopes, so we have to hand them the actual body.
 */
async function parseFunctionBody(source: string): Promise<unknown> {
  const result = await parseTypescriptFile({ path: "src/f.tsx", content: source })
  if (result.tree === null) throw new Error("parse returned null")
  interface Node {
    type: string
    namedChildren: readonly (Node | null)[]
    childForFieldName(name: string): Node | null
  }
  function find(node: Node): Node | null {
    if (
      node.type === "function_declaration" ||
      node.type === "arrow_function" ||
      node.type === "function_expression"
    ) {
      return node.childForFieldName("body")
    }
    for (const child of node.namedChildren) {
      if (child === null) continue
      const found = find(child)
      if (found !== null) return found
    }
    return null
  }
  const body = find(result.tree.rootNode as unknown as Node)
  if (body === null) throw new Error("no function body found in source")
  return body
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

  it("returns false for a non-tree-sitter input (duck-type mismatch guard)", () => {
    expect(hasJsxReturn({ placeholder: true })).toBe(false)
  })
})

describe("findReturnedJsxElementName", () => {
  it("returns null for a JSX-less body", async () => {
    const body = await parseFunctionBody("function f() { return 1 }")
    expect(findReturnedJsxElementName(body)).toBeNull()
  })

  it("returns the plain identifier name of a self-closing return", async () => {
    const body = await parseFunctionBody("function C() { return <Widget /> }")
    expect(findReturnedJsxElementName(body)).toBe("Widget")
  })

  it("returns the member expression text for a namespaced return element", async () => {
    const body = await parseFunctionBody(
      "function C() { return <MyContext.Provider>x</MyContext.Provider> }",
    )
    expect(findReturnedJsxElementName(body)).toBe("MyContext.Provider")
  })

  it("returns null for a fragment return (fragments have no name)", async () => {
    const body = await parseFunctionBody("function C() { return <>x</> }")
    expect(findReturnedJsxElementName(body)).toBeNull()
  })

  it("ignores JSX helpers defined above the return and picks the returned element", async () => {
    // Regression: pre-order walk would surface the helper's <div> before the
    // <Ctx.Provider>, causing provider detection to miss real Providers. The returned-
    // JSX walker must skip past helper JSX literals and pull the return statement's own.
    const body = await parseFunctionBody(
      "function Provider({ children }) { const badge = <div /> ; return <Ctx.Provider>{children}</Ctx.Provider> }",
    )
    expect(findReturnedJsxElementName(body)).toBe("Ctx.Provider")
  })

  it("does not descend into nested function scopes when finding the return", async () => {
    // The outer function returns null; a nested arrow returns <div/>. The outer's
    // returned JSX should be null, not "div".
    const body = await parseFunctionBody(
      "function Outer() { const cb = () => <div /> ; return null }",
    )
    expect(findReturnedJsxElementName(body)).toBeNull()
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

  it("rejects null (propagated from a JSX-less body)", () => {
    expect(isProviderElementName(null)).toBe(false)
  })

  it("rejects the empty string", () => {
    expect(isProviderElementName("")).toBe(false)
  })
})
