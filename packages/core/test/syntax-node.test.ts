import { describe, expect, it } from "vitest"
import {
  anyCallCalleeMatches,
  asSyntaxNode,
  calleeLeaf,
  calleeText,
  findFirstDescendantOfType,
  findNamedChildOfType,
  type SyntaxNode,
} from "../src/syntax-node"

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
})

describe("calleeLeaf", () => {
  it.each([
    ['app.route("/x").get', "get"],
    ["React.forwardRef", "forwardRef"],
    ["forwardRef", "forwardRef"],
  ])("reads %j as %j", (callee, leaf) => {
    expect(calleeLeaf(callee)).toBe(leaf)
  })
})

describe("findNamedChildOfType", () => {
  it("returns the first direct named child of the type, passing over null slots", () => {
    const first = node({ type: "identifier", text: "first" })
    const parent = node({
      type: "program",
      namedChildren: [null, node({ type: "comment" }), first, node({ type: "identifier" })],
    })

    expect(findNamedChildOfType(parent, "identifier")).toBe(first)
  })

  it("does not look below the direct children", () => {
    const parent = node({
      type: "program",
      namedChildren: [node({ type: "block", namedChildren: [node({ type: "identifier" })] })],
    })

    expect(findNamedChildOfType(parent, "identifier")).toBeNull()
  })
})

describe("findFirstDescendantOfType", () => {
  it("returns the node itself when it has the type", () => {
    const call = node({ namedChildren: [node()] })

    expect(findFirstDescendantOfType(call, "call_expression")).toBe(call)
  })

  it("returns the outermost match, searching depth-first in child order", () => {
    const inner = node({ text: "inner" })
    const outer = node({ text: "outer", namedChildren: [inner] })
    const tree = node({
      type: "program",
      namedChildren: [
        null,
        node({ type: "block", namedChildren: [outer] }),
        node({ text: "later" }),
      ],
    })

    expect(findFirstDescendantOfType(tree, "call_expression")).toBe(outer)
  })

  it("returns null when nothing in the tree has the type", () => {
    expect(findFirstDescendantOfType(node({ type: "program" }), "call_expression")).toBeNull()
  })
})

describe("anyCallCalleeMatches", () => {
  const isGet = (leaf: string) => leaf === "get"
  const call = (callee: string) => callWith(node({ type: "member_expression", text: callee }))

  it("accepts the node itself when it is a call whose callee leaf matches", () => {
    expect(anyCallCalleeMatches(call('app.route("/x").get'), isGet)).toBe(true)
  })

  it("accepts a matching call nested below other nodes", () => {
    const tree = node({
      type: "program",
      namedChildren: [null, node({ type: "block", namedChildren: [call("router.get")] })],
    })

    expect(anyCallCalleeMatches(tree, isGet)).toBe(true)
  })

  it.each([
    ["a call whose callee leaf does not match", call("router.post")],
    ["a call with no callee", callWith(null)],
    ["a node that is not a call", node({ type: "member_expression", text: "router.get" })],
  ])("rejects %s", (_case, tree) => {
    expect(anyCallCalleeMatches(tree, isGet)).toBe(false)
  })
})
