import type { Node } from "web-tree-sitter"

export type Unmodelled = "skip" | ((node: Node) => never)

export function collectPatternBindings(pattern: Node, unmodelled: Unmodelled): Node[] {
  const out: Node[] = []
  const visit = (node: Node, repaired: boolean): void => {
    const type = repaired ? (EXPRESSION_SPELLING.get(node.type) ?? node.type) : node.type
    switch (type) {
      case "identifier":
      case "shorthand_property_identifier_pattern":
        out.push(node)
        return
      case "object_pattern":
      case "array_pattern":
        for (const child of node.namedChildren) {
          if (child !== null) visit(child, repaired)
        }
        return
      case "pair_pattern": {
        const value = node.childForFieldName("value")
        if (value !== null) visit(value, repaired)
        return
      }
      case "assignment_pattern":
      case "object_assignment_pattern": {
        // `left` is the binding; `right` is a default expression evaluated elsewhere.
        const left = node.childForFieldName("left") ?? node.namedChild(0)
        if (left !== null) visit(left, repaired)
        return
      }
      case "rest_pattern": {
        const inner = node.namedChild(0)
        if (inner !== null) visit(inner, repaired)
        return
      }
      case "comment":
        return
      default:
        if (unmodelled !== "skip") unmodelled(node)
        if (isRepairedPattern(node)) {
          const operand = node.namedChild(0)
          if (operand !== null) visit(operand, true)
        }
    }
  }
  visit(pattern, false)
  return out
}

export function isRepairedPattern(node: Node): boolean {
  if (node.type !== "non_null_expression") return false
  const bang = node.lastChild
  if (bang === null || bang.type !== "!" || !bang.isMissing) return false
  const operand = node.namedChild(0)
  return operand !== null && (operand.type === "array" || operand.type === "object")
}

const EXPRESSION_SPELLING: ReadonlyMap<string, string> = new Map([
  ["array", "array_pattern"],
  ["object", "object_pattern"],
  ["pair", "pair_pattern"],
  ["shorthand_property_identifier", "shorthand_property_identifier_pattern"],
  ["assignment_expression", "assignment_pattern"],
  ["spread_element", "rest_pattern"],
])
