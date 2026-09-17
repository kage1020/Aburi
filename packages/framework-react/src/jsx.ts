import { asSyntaxNode, findNamedChildOfType, type SyntaxNode } from "@aburi/core"

/** Tree-sitter node types the tsx grammar uses for JSX. */
const JSX_NODE_TYPES: ReadonlySet<string> = new Set([
  "jsx_element",
  "jsx_self_closing_element",
  "jsx_fragment",
  "jsx_opening_element",
])

/** JSX element forms that carry a `name` field (fragments do not). */
const JSX_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  "jsx_element",
  "jsx_self_closing_element",
  "jsx_fragment",
])

/** Node types that open a new function scope: a nested arrow's return is not the enclosing body's. */
const FUNCTION_SCOPE_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "generator_function_declaration",
  "method_definition",
])

/**
 * True when `body` contains JSX anywhere — the loose component signal. Accepts anything so
 * callers can pass `symbol.bodyNode` verbatim; `false` for non-tree-sitter values.
 */
export function hasJsxReturn(body: unknown): boolean {
  const node = asSyntaxNode(body)
  if (node === null) return false
  return findFirstJsxDescendant(node) !== null
}

/**
 * Element name of the JSX the function actually returns, or `null`. Handles an arrow
 * expression body (the body IS the JSX) and a statement block (first `return_statement`,
 * nested function scopes excluded). Provider detection needs this because "JSX somewhere in
 * the body" would mistake a `<div/>` helper above `return <Ctx.Provider>` for the return.
 */
export function findReturnedJsxElementName(body: unknown): string | null {
  const node = asSyntaxNode(body)
  if (node === null) return null
  const jsx = findReturnedJsxElement(node)
  if (jsx === null) return null
  return jsxElementName(jsx)
}

/**
 * True for a member expression ending in `.Provider` (`MyContext.Provider`). A bare
 * `<Provider>` could be any component, so it is excluded. Accepts `null` for chaining.
 */
export function isProviderElementName(name: string | null): boolean {
  if (name === null || name === "") return false
  const dot = name.lastIndexOf(".")
  if (dot < 0) return false
  return name.slice(dot + 1) === "Provider"
}

function findFirstJsxDescendant(node: SyntaxNode): SyntaxNode | null {
  if (JSX_NODE_TYPES.has(node.type)) return node
  for (const child of node.children) {
    if (child === null) continue
    const found = findFirstJsxDescendant(child)
    if (found !== null) return found
  }
  return null
}

function findReturnedJsxElement(body: SyntaxNode): SyntaxNode | null {
  if (JSX_ELEMENT_TYPES.has(body.type)) return body
  return walkForReturnedJsx(body)
}

function walkForReturnedJsx(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "return_statement") {
    for (const child of node.namedChildren) {
      if (child === null) continue
      const jsx = findFirstJsxElementOnly(child)
      if (jsx !== null) return jsx
    }
    return null
  }
  if (FUNCTION_SCOPE_TYPES.has(node.type)) return null
  for (const child of node.namedChildren) {
    if (child === null) continue
    const found = walkForReturnedJsx(child)
    if (found !== null) return found
  }
  return null
}

/** Like `findFirstJsxDescendant` but ignores bare `jsx_opening_element` nodes. */
function findFirstJsxElementOnly(node: SyntaxNode): SyntaxNode | null {
  if (JSX_ELEMENT_TYPES.has(node.type)) return node
  for (const child of node.namedChildren) {
    if (child === null) continue
    const found = findFirstJsxElementOnly(child)
    if (found !== null) return found
  }
  return null
}

/** Opening-element name; `null` for fragments (no name) and for a missing `name` field. */
function jsxElementName(node: SyntaxNode): string | null {
  if (node.type === "jsx_fragment") return null
  if (node.type === "jsx_self_closing_element") {
    const name = node.childForFieldName("name")
    return name === null ? null : name.text
  }
  const opening =
    node.childForFieldName("open_tag") ?? findNamedChildOfType(node, "jsx_opening_element")
  if (opening === null) return null
  const name = opening.childForFieldName("name")
  return name === null ? null : name.text
}
