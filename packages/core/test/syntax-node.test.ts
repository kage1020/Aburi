import { describe, expect, it } from "vitest"
import { asSyntaxNode, calleeText, type SyntaxNode } from "../src/syntax-node"

/**
 * `syntax-node.ts` is the seam every framework plugin walks a tree-sitter node through, so it
 * is tested here rather than through one plugin: `framework-express`, `framework-react` and
 * anything that follows all reach these helpers, and a plugin's own suite would only pin the
 * subset that plugin happens to exercise.
 */

/**
 * A stand-in carrying the whole duck-typed surface. `asSyntaxNode` is a shape check, so an
 * object that merely satisfies the shape is exactly what a plugin hands over — there is no
 * `web-tree-sitter` node to construct and nothing here needs one.
 */
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

  /**
   * An empty callee answers `null`, not `""`. Every caller asks the result a question about a
   * name — does its last dotted segment match a hook, is it `express()`, is it `forwardRef` —
   * and `""` is a callee that matches nothing while still reading as present, so a caller that
   * checks for absence before matching would be told there is a callee to inspect when there
   * is not.
   */
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

  /**
   * `text` is asserted because `calleeText` reads `callee.text.length` unconditionally. A node
   * that passed the guard without one would fail as a `TypeError` inside the helper the guard
   * exists to keep non-tree-sitter values out of, which is the failure a plugin gets no
   * chance to handle.
   */
  it("refuses a node missing `text`, which `calleeText` reads without checking", () => {
    const withoutText = {
      type: "call_expression",
      namedChildren: [],
      children: [],
      childForFieldName: () => null,
    }
    expect(asSyntaxNode(withoutText)).toBeNull()
  })

  /**
   * `children` is asserted for the same reason one step further out: nothing in the module
   * reads it, but `framework-react`'s JSX walk iterates it straight off the narrowed value.
   */
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
