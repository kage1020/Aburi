import { asSyntaxNode, type SyntaxNode } from "./ast"

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

/** Tree-sitter node types that open a new function scope; we stop descending here when
 * looking for a body's own return-value, so a nested arrow's `<X.Provider>` does not
 * bubble up as if the enclosing function returned it. */
const FUNCTION_SCOPE_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "generator_function_declaration",
  "method_definition",
])

/**
 * True when `body` (or any descendant) contains a JSX element / fragment. This is the
 * generic "returns JSX at all" component signal — helper JSX literals inside the body
 * count as evidence that the enclosing function is JSX-producing.
 *
 * Accepts anything so callers can pass `symbol.bodyNode` verbatim; returns `false` for
 * `null`, non-tree-sitter values, or bodies with no JSX.
 */
export function hasJsxReturn(body: unknown): boolean {
  const node = asSyntaxNode(body)
  if (node === null) return false
  return findFirstJsxDescendant(node) !== null
}

/**
 * Return the element name of the JSX the function actually returns, or `null` when the
 * body returns nothing JSX-shaped. Used by provider detection where "JSX exists somewhere
 * in the body" is too loose — a `<div/>` helper defined above `return <Ctx.Provider>` must
 * not be mistaken for the returned element.
 *
 * Two body shapes matter:
 *   - arrow expression body: `bodyNode` IS the JSX expression itself
 *   - statement block body: walk into `return_statement`s and read their argument's JSX
 *
 * Nested function scopes are not descended into: an inner arrow returning JSX is that
 * inner function's return value, not the outer one's.
 */
export function findReturnedJsxElementName(body: unknown): string | null {
  const node = asSyntaxNode(body)
  if (node === null) return null
  const jsx = findReturnedJsxElement(node)
  if (jsx === null) return null
  return jsxElementName(jsx)
}

/**
 * True when `name` denotes a member expression whose final segment is `Provider`, e.g.
 * `MyContext.Provider`, `foo.bar.Provider`. Plain identifiers named `Provider` are
 * intentionally excluded — the unambiguous context-provider signal requires the namespace
 * qualifier; a bare `<Provider>` component could be anything.
 *
 * Accepts `null` (naturally propagates from `findReturnedJsxElementName` when the body
 * returned no JSX) so callers can chain without a pre-guard.
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
  // Arrow expression body: the JSX IS the body itself.
  if (JSX_ELEMENT_TYPES.has(body.type)) return body

  // Statement block body: find the first return_statement (skipping nested functions)
  // and pull the JSX out of its argument.
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
  // Don't descend into nested function scopes — those returns belong to them, not us.
  if (FUNCTION_SCOPE_TYPES.has(node.type)) return null
  for (const child of node.namedChildren) {
    if (child === null) continue
    const found = walkForReturnedJsx(child)
    if (found !== null) return found
  }
  return null
}

/**
 * Pre-order find the first `jsx_element` / `jsx_self_closing_element` / `jsx_fragment`
 * under `node`. Unlike `findFirstJsxDescendant`, this ignores bare `jsx_opening_element`
 * nodes — the wrapping element form is what provider detection reasons about.
 */
function findFirstJsxElementOnly(node: SyntaxNode): SyntaxNode | null {
  if (JSX_ELEMENT_TYPES.has(node.type)) return node
  for (const child of node.namedChildren) {
    if (child === null) continue
    const found = findFirstJsxElementOnly(child)
    if (found !== null) return found
  }
  return null
}

/**
 * Extract the opening-element name for a JSX element node. Returns `null` for fragments
 * (they have no name) AND for grammar-shape breakage (missing `name` field / opening
 * element). Returning `null` in both cases lets provider detection treat them uniformly
 * as "not a namespaced Provider" without silently masking a grammar bug: consumers that
 * care about the difference between "fragment" and "shape broken" can distinguish via
 * the node's `type` directly.
 */
function jsxElementName(node: SyntaxNode): string | null {
  if (node.type === "jsx_fragment") return null
  if (node.type === "jsx_self_closing_element") {
    const name = node.childForFieldName("name")
    return name === null ? null : name.text
  }
  // jsx_element — walk to its opening element and read the `name` field.
  const opening = node.childForFieldName("open_tag") ?? findChildOfType(node, "jsx_opening_element")
  if (opening === null) return null
  const name = opening.childForFieldName("name")
  return name === null ? null : name.text
}

function findChildOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
  }
  return null
}
