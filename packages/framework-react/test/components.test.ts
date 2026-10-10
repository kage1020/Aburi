import { describe, expect, it } from "vitest"
import {
  hasJsxReturn,
  isPascalCase,
  matchesHocNaming,
  returnsContextProvider,
  returnsJsx,
} from "../src/index"
import { candidateNamed } from "./fixtures/symbol"

async function bodyOf(source: string): Promise<unknown> {
  return (await candidateNamed(source, "C")).bodyNode
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
  it.each([
    ["function C() { return <div /> }", true],
    ["function C() { return 42 }", false],
  ])("answers as hasJsxReturn does for %s", async (source, expected) => {
    const body = await bodyOf(source)
    expect(returnsJsx(body)).toBe(expected)
    expect(hasJsxReturn(body)).toBe(expected)
  })
})

describe("returnsContextProvider", () => {
  it.each([
    [
      "<X.Provider>",
      true,
      "function C({ children }) { return <MyCtx.Provider>{children}</MyCtx.Provider> }",
    ],
    [
      "<X.Provider> as an arrow's body",
      true,
      "const C = ({ children }) => <MyCtx.Provider>{children}</MyCtx.Provider>",
    ],
    ["a bare <Provider>", false, "function C() { return <Provider>x</Provider> }"],
    ["no JSX", false, "function C() { return null }"],
  ])("reads a function returning %s as a provider: %s", async (_label, expected, source) => {
    expect(returnsContextProvider(await bodyOf(source))).toBe(expected)
  })
})
