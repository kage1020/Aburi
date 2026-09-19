import { parseTypescriptFile } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import {
  hasJsxReturn,
  isPascalCase,
  matchesHocNaming,
  returnsContextProvider,
  returnsJsx,
} from "../src/index"

/** Return the body node of the first function-like declaration — matches how the plugin
 * hands `symbol.bodyNode` to `returnsContextProvider` in production. */
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

describe("isPascalCase", () => {
  it.each([
    ["Button", true],
    ["MyThing", true],
    ["A", true],
    ["button", false],
    ["myThing", false],
    ["_Button", false],
    ["", false],
  ])("isPascalCase(%j) === %j", (leaf, expected) => {
    expect(isPascalCase(leaf)).toBe(expected)
  })
})

describe("matchesHocNaming", () => {
  it.each([
    ["withRouter", true],
    ["withAuth", true],
    ["withX", true],
    ["with", false],
    ["within", false],
    ["without", false],
    ["Wrap", false],
    ["", false],
  ])("matchesHocNaming(%j) === %j", (leaf, expected) => {
    expect(matchesHocNaming(leaf)).toBe(expected)
  })
})

// `returnsJsx` is a one-line alias of `hasJsxReturn`, whose walker jsx.test.ts already covers
// form by form — repeating that table here would pin the same behaviour twice. What only this
// file can pin is the alias: it is part of the package's public surface, so a barrel that
// dropped it or an alias re-pointed at the neighbouring `returnsContextProvider` would break
// consumers with nothing else going red. Hence both directions plus the agreement check: one
// case alone would still pass against a predicate that is constantly true or constantly false.
describe("returnsJsx", () => {
  it("is true when the function returns JSX, and agrees with hasJsxReturn", async () => {
    const body = await parseFunctionBody("function C() { return <div /> }")
    expect(returnsJsx(body)).toBe(true)
    expect(returnsJsx(body)).toBe(hasJsxReturn(body))
  })

  it("is false when the function returns a plain value, and agrees with hasJsxReturn", async () => {
    const body = await parseFunctionBody("function C() { return 42 }")
    expect(returnsJsx(body)).toBe(false)
    expect(returnsJsx(body)).toBe(hasJsxReturn(body))
  })
})

describe("returnsContextProvider", () => {
  it("is true when the returned JSX is <X.Provider>", async () => {
    const body = await parseFunctionBody(
      "function P({ children }) { return <MyCtx.Provider>{children}</MyCtx.Provider> }",
    )
    expect(returnsContextProvider(body)).toBe(true)
  })

  it("is false when the returned JSX is not a namespaced Provider", async () => {
    const body = await parseFunctionBody("function C() { return <Provider>x</Provider> }")
    expect(returnsContextProvider(body)).toBe(false)
  })

  it("is false when the returned JSX is a different element", async () => {
    const body = await parseFunctionBody("function C() { return <div /> }")
    expect(returnsContextProvider(body)).toBe(false)
  })

  it("is false when the body returns no JSX at all", async () => {
    const body = await parseFunctionBody("function C() { return null }")
    expect(returnsContextProvider(body)).toBe(false)
  })

  it("is true even when a JSX helper is defined above the returned Provider", async () => {
    // Regression guard: pre-order walkers would surface the helper's <div/> first and
    // miss the actual returned Provider. The returned-JSX walker must ignore the helper.
    const body = await parseFunctionBody(
      "function Provider({ children }) { const badge = <div /> ; return <MyCtx.Provider>{children}</MyCtx.Provider> }",
    )
    expect(returnsContextProvider(body)).toBe(true)
  })
})
