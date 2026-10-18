import { describe, expect, it } from "vitest"
import {
  anyCallCalleeMatches,
  asSyntaxNode,
  calleeLeaf,
  calleeName,
  calleeText,
  declaratorValue,
  findFirstDescendantOfType,
  findNamedChildOfType,
  type SyntaxNode,
  unwrapValue,
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

describe("calleeName", () => {
  const identifier = (text: string) => node({ type: "identifier", text })
  const withFields = (type: string, fields: Record<string, SyntaxNode>) =>
    node({ type, childForFieldName: (name) => fields[name] ?? null })
  const member = (object: SyntaxNode, property: string) =>
    withFields("member_expression", {
      object,
      property: node({ type: "property_identifier", text: property }),
    })
  const call = (callee: SyntaxNode) => withFields("call_expression", { function: callee })
  const wrapped = (type: string, inner: SyntaxNode) =>
    node({ type, namedChildren: [node({ type: "comment", text: "/* c */" }), inner] })

  it.each([
    ["a bare identifier", identifier("Router"), "Router", "Router"],
    ["a member", member(identifier("express"), "Router"), "express.Router", "Router"],
    [
      "a chain through calls by its first name",
      member(call(member(identifier("app"), "route")), "get"),
      "app.get",
      "get",
    ],
    [
      "a receiver behind wrappers and a comment",
      member(
        wrapped("parenthesized_expression", wrapped("as_expression", identifier("app"))),
        "get",
      ),
      "app.get",
      "get",
    ],
    [
      "a receiver reached through an index",
      member(withFields("subscript_expression", { object: identifier("routers") }), "get"),
      "routers.get",
      "get",
    ],
    [
      "a chain from this",
      member(member(node({ type: "this", text: "this" }), "app"), "get"),
      "this.get",
      "get",
    ],
    [
      "a receiver that is not a name as computed",
      member(node({ type: "new_expression", text: "new Lib()" }), "get"),
      "<computed>.get",
      "get",
    ],
  ])("names %s", (_label, callee, name, leaf) => {
    expect(calleeName(callWith(callee))).toEqual({ name, leaf })
  })

  it.each([
    ["no callee", null],
    ["a callee written in parentheses", wrapped("parenthesized_expression", identifier("memo"))],
    ["a member with no property", withFields("member_expression", { object: identifier("app") })],
    ["an identifier with no text", identifier("")],
  ])("returns null for %s", (_label, callee) => {
    expect(calleeName(callWith(callee))).toBeNull()
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

describe("unwrapValue", () => {
  const value = node({ text: "memo(Inner)" })
  const wrapped = (type: string, ...namedChildren: SyntaxNode[]) => node({ type, namedChildren })

  it.each([
    ["parentheses", wrapped("parenthesized_expression", value)],
    ["`as`", wrapped("as_expression", value, node({ type: "type_query" }))],
    ["`satisfies`", wrapped("satisfies_expression", value, node({ type: "type_identifier" }))],
    ["`!`", wrapped("non_null_expression", value)],
    [
      "several wrappers",
      wrapped(
        "non_null_expression",
        wrapped("as_expression", wrapped("parenthesized_expression", value)),
      ),
    ],
    [
      "a comment inside parentheses",
      wrapped("parenthesized_expression", node({ type: "comment" }), value),
    ],
  ])("reads through %s to the value", (_label, outer) => {
    expect(unwrapValue(outer)).toBe(value)
  })

  it("does not read through `<T>x`", () => {
    const assertion = wrapped("type_assertion", node({ type: "type_arguments" }), value)
    expect(unwrapValue(assertion)).toBe(assertion)
  })

  it("stops at the wrapper holding only a comment", () => {
    const empty = wrapped("parenthesized_expression", node({ type: "comment" }))
    expect(unwrapValue(wrapped("non_null_expression", empty))).toBe(empty)
  })
})

describe("declaratorValue", () => {
  const identifier = (text: string) => node({ type: "identifier", text })
  const declarator = (name: SyntaxNode, value: SyntaxNode | null) =>
    node({
      type: "variable_declarator",
      childForFieldName: (field) => (field === "name" ? name : field === "value" ? value : null),
    })
  const statement = (...declarators: (SyntaxNode | null)[]) =>
    node({ type: "lexical_declaration", namedChildren: declarators })
  const first = node({ text: "createContext(null)" })
  const second = node({ text: "memo(Inner)" })

  it("returns the value of the declarator binding the name, wherever it is in the statement", () => {
    const declaration = statement(
      declarator(identifier("Ctx"), first),
      null,
      declarator(identifier("Row"), second),
    )
    expect(declaratorValue(declaration, "Ctx")).toBe(first)
    expect(declaratorValue(declaration, "Row")).toBe(second)
  })

  it("reads the value through its wrappers", () => {
    const asCast = node({
      type: "as_expression",
      namedChildren: [second, node({ type: "type_query" })],
    })
    expect(declaratorValue(statement(declarator(identifier("Row"), asCast)), "Row")).toBe(second)
  })

  it.each([
    ["no declarator binds it", statement(declarator(identifier("Row"), second))],
    ["its declarator has no initializer", statement(declarator(identifier("Ctx"), null))],
    [
      "only a destructuring pattern binds it",
      statement(declarator(node({ type: "object_pattern", text: "{ Ctx }" }), first)),
    ],
  ])("returns null for a name when %s", (_label, declaration) => {
    expect(declaratorValue(declaration, "Ctx")).toBeNull()
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
