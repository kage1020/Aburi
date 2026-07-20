import { parseTypescriptFile } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { isPascalCase, matchesHocNaming, returnsContextProvider, returnsJsx } from "../src/index"

async function parseRoot(source: string): Promise<unknown> {
  const result = await parseTypescriptFile({ path: "src/f.tsx", content: source })
  if (result.tree === null) throw new Error("parse returned null")
  return result.tree.rootNode
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

describe("returnsJsx", () => {
  it("is true when a function returns JSX", async () => {
    const root = await parseRoot("function C() { return <div /> }")
    expect(returnsJsx(root)).toBe(true)
  })

  it("is false when a function returns a plain value", async () => {
    const root = await parseRoot("function C() { return 42 }")
    expect(returnsJsx(root)).toBe(false)
  })
})

describe("returnsContextProvider", () => {
  it("is true when the returned JSX is <X.Provider>", async () => {
    const root = await parseRoot(
      "function P({ children }) { return <MyCtx.Provider>{children}</MyCtx.Provider> }",
    )
    expect(returnsContextProvider(root)).toBe(true)
  })

  it("is false when the returned JSX is not a namespaced Provider", async () => {
    const root = await parseRoot("function C() { return <Provider>x</Provider> }")
    expect(returnsContextProvider(root)).toBe(false)
  })

  it("is false when the returned JSX is a different element", async () => {
    const root = await parseRoot("function C() { return <div /> }")
    expect(returnsContextProvider(root)).toBe(false)
  })

  it("is false when the body returns no JSX at all", async () => {
    const root = await parseRoot("function C() { return null }")
    expect(returnsContextProvider(root)).toBe(false)
  })
})
