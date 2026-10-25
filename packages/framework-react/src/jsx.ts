import { asSyntaxNode, findNamedChildOfType, type SyntaxNode, unwrapValue } from "@aburi/core"

const JSX_NODE_TYPES: ReadonlySet<string> = new Set([
  "jsx_element",
  "jsx_self_closing_element",
  "jsx_fragment",
  "jsx_opening_element",
])

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
  "generator_function",
  "method_definition",
])

const FALLBACK_OPERATORS: ReadonlySet<string> = new Set(["||", "??"])

export function hasJsxReturn(body: unknown): boolean {
  const node = asSyntaxNode(body)
  if (node === null) return false
  return findFirstJsxDescendant(node) !== null
}

export function findReturnedJsxElementNames(body: unknown): string[] {
  const node = asSyntaxNode(body)
  if (node === null) return []
  const values: SyntaxNode[] = []
  // A concise arrow's body is the value it returns.
  if (node.type === "statement_block") collectReturnedValues(node, values)
  else values.push(node)
  const elements: SyntaxNode[] = []
  for (const value of values) collectReturnedElements(value, elements)
  return elements.map(jsxElementName).filter((name) => name !== null)
}

export function findReturnedJsxElementName(body: unknown): string | null {
  return findReturnedJsxElementNames(body)[0] ?? null
}

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

function collectReturnedValues(node: SyntaxNode, into: SyntaxNode[]): void {
  if (node.type === "return_statement") {
    for (const child of node.namedChildren) if (child !== null) into.push(child)
    return
  }
  if (FUNCTION_SCOPE_TYPES.has(node.type)) return
  for (const child of node.namedChildren) if (child !== null) collectReturnedValues(child, into)
}

function collectReturnedElements(expression: SyntaxNode, into: SyntaxNode[]): void {
  const value = unwrapValue(expression)
  if (JSX_ELEMENT_TYPES.has(value.type)) into.push(value)
  for (const branch of branchesOf(value)) if (branch !== null) collectReturnedElements(branch, into)
}

function branchesOf(value: SyntaxNode): (SyntaxNode | null)[] {
  switch (value.type) {
    case "ternary_expression":
      return [value.childForFieldName("consequence"), value.childForFieldName("alternative")]
    case "binary_expression": {
      const operator = value.childForFieldName("operator")?.type ?? ""
      const left = value.childForFieldName("left")
      // An element is never falsy or nullish: `a && b` can only yield an element as `b`, and
      // `<A /> || b` and `<A /> ?? b` always yield `<A />`.
      if (operator === "&&") return [value.childForFieldName("right")]
      if (!FALLBACK_OPERATORS.has(operator)) return []
      if (left !== null && JSX_ELEMENT_TYPES.has(unwrapValue(left).type)) return [left]
      return [left, value.childForFieldName("right")]
    }
    default:
      return []
  }
}

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
