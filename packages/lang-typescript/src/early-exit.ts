import type { Node } from "web-tree-sitter"
import { describeCallee } from "./callee"
import { LOOP_KINDS } from "./rules"

export function containsEarlyExit(node: Node): boolean {
  return exitsFrom(node, NO_INNER_TARGETS)
}

interface ExitScope {
  readonly inFunction: boolean
  readonly inLoop: boolean
  readonly inSwitch: boolean
  readonly labels: readonly string[]
}

const NO_INNER_TARGETS: ExitScope = {
  inFunction: false,
  inLoop: false,
  inSwitch: false,
  labels: [],
}

const EXIT_BOUNDARIES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
  "class_static_block",
])

function exitsFrom(node: Node, scope: ExitScope): boolean {
  switch (node.type) {
    case "throw_statement":
      return true
    case "return_statement":
      if (!scope.inFunction) return true
      break
    case "break_statement":
    case "continue_statement": {
      if (scope.inFunction) return false
      const label = node.childForFieldName("label")
      if (label !== null) return !scope.labels.includes(label.text)
      return node.type === "break_statement" ? !scope.inLoop && !scope.inSwitch : !scope.inLoop
    }
    case "call_expression": {
      const callee = node.childForFieldName("function")
      if (callee !== null && describeCallee(callee)?.target === "process.exit") return true
      break
    }
  }
  const inner = scopeInside(node, scope)
  for (const child of node.namedChildren) {
    if (child !== null && exitsFrom(child, inner)) return true
  }
  return false
}

function scopeInside(node: Node, scope: ExitScope): ExitScope {
  if (EXIT_BOUNDARIES.has(node.type)) return { ...scope, inFunction: true }
  if (LOOP_KINDS.has(node.type)) return { ...scope, inLoop: true }
  if (node.type === "switch_statement") return { ...scope, inSwitch: true }
  if (node.type === "labeled_statement") {
    const label = node.childForFieldName("label")
    if (label !== null) return { ...scope, labels: [...scope.labels, label.text] }
  }
  return scope
}
