import { describe, expect, it } from "vitest"
import { asSyntaxNode, calleeText, type SyntaxNode } from "../src/syntax-node"

function node(overrides: Partial<SyntaxNode> = {}): SyntaxNode {
  return {
    type: "call_expression",
    text: "",
    namedChildren: [],
    children: [],
    childForFieldName: () => null,
    ...overrides,
  }
}

/** A `call_expression` whose `function` field is `callee` and whose other fields are absent. */
function callWith(callee: SyntaxNode | null): SyntaxNode {
  return node({ childForFieldName: (name) => (name === "function" ? callee : null) })
}

describe("calleeText", () => {
  it("returns the verbatim source of the `function` field", () => {
    const call = callWith(node({ type: "member_expression", text: 'app.route("/x").get' }))
    expect(calleeText(call)).toBe('app.route("/x").get')
  })

  it("returns null when the call has no `function` field", () => {
    expect(calleeText(callWith(null))).toBeNull()
  })

  it("returns null for a `function` field whose text is empty", () => {
    expect(calleeText(callWith(node({ type: "identifier", text: "" })))).toBeNull()
  })
})

describe("asSyntaxNode", () => {
  it("narrows a value carrying the whole surface, handing back the value itself", () => {
    const candidate = node({ text: "forwardRef(Inner)" })
    expect(asSyntaxNode(candidate)).toBe(candidate)
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "call_expression"],
    ["a number", 7],
  ])("returns null for %s", (_label, value) => {
    expect(asSyntaxNode(value)).toBeNull()
  })

  it.each<[string, unknown]>([
    ["type", 7],
    ["text", 7],
    ["namedChildren", null],
    ["children", "not an array"],
    ["childForFieldName", "not a function"],
  ])("returns null when `%s` is not the shape tree-sitter gives it", (field, value) => {
    expect(asSyntaxNode({ ...node(), [field]: value })).toBeNull()
  })

  it("refuses a node missing `text`, which `calleeText` reads without checking", () => {
    const withoutText = {
      type: "call_expression",
      namedChildren: [],
      children: [],
      childForFieldName: () => null,
    }
    expect(asSyntaxNode(withoutText)).toBeNull()
  })

  it("refuses a node missing `children` even though no helper here reads it", () => {
    const withoutChildren = {
      type: "jsx_element",
      text: "<div />",
      namedChildren: [],
      childForFieldName: () => null,
    }
    expect(asSyntaxNode(withoutChildren)).toBeNull()
  })
})
