import { normalizeRuleText } from "@aburi/core"
import type { Rule } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { walkDescendants } from "./ast-helpers"
import { TYPE_WRAPPER_TYPES, wrappedExpression } from "./callee"

export const LOOP_KINDS: ReadonlyMap<string, NonNullable<Rule["loopKind"]>> = new Map([
  ["for_statement", "for"],
  ["for_in_statement", "for"],
  ["while_statement", "while"],
  ["do_statement", "do"],
])

export function makeRule(
  type: Rule["type"],
  node: Node,
  overrides: Partial<Pick<Rule, "condition" | "what" | "expr" | "loopKind">> = {},
): Rule {
  return {
    type,
    line: node.startPosition.row + 1,
    condition: overrides.condition ?? null,
    what: overrides.what ?? null,
    expr: overrides.expr ?? null,
    loopKind: overrides.loopKind ?? null,
  }
}

export function ruleText(node: Node, from = node.startIndex, to = node.endIndex): string {
  const source = node.text
  const base = node.startIndex
  if (!source.includes("/")) return normalizeRuleText(source.slice(from - base, to - base))
  let out = ""
  let at = from
  for (const descendant of walkDescendants(node)) {
    if (descendant.type !== "comment") continue
    out += `${source.slice(at - base, descendant.startIndex - base)} `
    at = descendant.endIndex
  }
  out += source.slice(at - base, to - base)
  return normalizeRuleText(out)
}

export function conditionText(condition: Node): string {
  const open = condition.child(0)
  const close = condition.child(condition.childCount - 1)
  if (
    condition.type !== "parenthesized_expression" ||
    open?.type !== "(" ||
    close?.type !== ")" ||
    open.equals(close)
  ) {
    return ruleText(condition)
  }
  return ruleText(condition, open.endIndex, close.startIndex)
}

export function isTrivialExpr(node: Node): boolean {
  switch (node.type) {
    case "number":
    case "string":
    case "true":
    case "false":
    case "null":
    case "undefined":
    case "identifier":
    case "this":
    case "super":
      return true
    case "member_expression": {
      const object = node.childForFieldName("object")
      return object !== null && isTrivialExpr(object)
    }
    case "subscript_expression": {
      const object = node.childForFieldName("object")
      const index = node.childForFieldName("index")
      if (object === null || index === null) return false
      return isTrivialExpr(object) && isTrivialExpr(withoutTypeWrappers(index))
    }
    case "unary_expression":
    case "update_expression": {
      const argument = node.childForFieldName("argument") ?? node.namedChild(0)
      return argument !== null && isTrivialExpr(argument)
    }
    case "parenthesized_expression": {
      const inner = node.namedChild(0)
      return inner !== null && isTrivialExpr(inner)
    }
    default:
      return false
  }
}

function withoutTypeWrappers(index: Node): Node {
  let cursor = index
  while (TYPE_WRAPPER_TYPES.has(cursor.type) || cursor.type === "parenthesized_expression") {
    const inner = wrappedExpression(cursor)
    if (inner === null) return cursor
    cursor = inner
  }
  return cursor
}
