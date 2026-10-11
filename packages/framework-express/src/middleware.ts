import { asSyntaxNode, type SyntaxNode } from "@aburi/core"

export const EXPRESS_MIDDLEWARE_METHOD = "use"

export const ERROR_MIDDLEWARE_ARITY = 4
export const REGULAR_HANDLER_ARITY = 3

export interface UseArgumentShape {
  readonly hasErrorHandler: boolean
  readonly hasRegularHandler: boolean
  readonly firstArgIsPathLiteral: boolean
  readonly secondArgIsIdentifier: boolean
  readonly argCount: number
  readonly hasIdentifierArg: boolean
}

export function analyzeUseArguments(callExpression: unknown): UseArgumentShape | null {
  const node = asSyntaxNode(callExpression)
  if (node === null) return null
  const argsNode = findArguments(node)
  if (argsNode === null) return null

  const argChildren: SyntaxNode[] = []
  for (const child of argsNode.namedChildren) {
    if (child !== null && child.type !== "comment") argChildren.push(child)
  }

  let hasErrorHandler = false
  let hasRegularHandler = false
  let hasIdentifierArg = false

  for (const arg of argChildren) {
    if (isFunctionLike(arg)) {
      const arity = functionArity(arg)
      if (arity === ERROR_MIDDLEWARE_ARITY) hasErrorHandler = true
      else if (arity === REGULAR_HANDLER_ARITY) hasRegularHandler = true
      // Other arities (`(req, res) => …`) are legal but match neither shape.
      continue
    }
    if (isIdentifier(arg)) hasIdentifierArg = true
  }

  const first = argChildren[0]
  const second = argChildren[1]
  return {
    hasErrorHandler,
    hasRegularHandler,
    firstArgIsPathLiteral: first !== undefined && isPathLiteral(first),
    secondArgIsIdentifier: second !== undefined && isIdentifier(second),
    argCount: argChildren.length,
    hasIdentifierArg,
  }
}

function findArguments(callExpression: SyntaxNode): SyntaxNode | null {
  const named = callExpression.childForFieldName("arguments")
  if (named !== null) return named
  for (const child of callExpression.namedChildren) {
    if (child !== null && child.type === "arguments") return child
  }
  return null
}

function isFunctionLike(node: SyntaxNode): boolean {
  return node.type === "arrow_function" || node.type === "function_expression"
}

function functionArity(fn: SyntaxNode): number {
  const params =
    fn.childForFieldName("parameters") ??
    fn.childForFieldName("parameter") ??
    findParametersChild(fn)
  if (params === null) return 0
  let count = 0
  for (const child of params.namedChildren) {
    if (child === null) continue
    // Every named child but a comment is a formal parameter.
    if (child.type === "comment") continue
    count += 1
  }
  return count
}

function findParametersChild(fn: SyntaxNode): SyntaxNode | null {
  for (const child of fn.namedChildren) {
    if (child !== null && (child.type === "formal_parameters" || child.type === "parameter")) {
      return child
    }
  }
  return null
}

function isIdentifier(node: SyntaxNode): boolean {
  return node.type === "identifier"
}

function isPathLiteral(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  if (value.type === "string") return true
  if (value.type !== "template_string") return false
  return value.namedChildren.every((child) => child?.type !== "template_substitution")
}

const VALUE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
])

function unwrapValue(node: SyntaxNode): SyntaxNode {
  let cursor = node
  while (VALUE_WRAPPER_TYPES.has(cursor.type)) {
    const inner = cursor.namedChildren.find((child) => child !== null && child.type !== "comment")
    if (inner === undefined || inner === null) return cursor
    cursor = inner
  }
  return cursor
}
