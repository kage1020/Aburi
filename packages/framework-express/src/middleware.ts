import { asSyntaxNode, type SyntaxNode } from "@aburi/core"

/** Method name that registers middleware / error-middleware / mount points. */
export const EXPRESS_MIDDLEWARE_METHOD = "use"

/** Number of parameters an Express error-handling middleware must expose. */
export const ERROR_MIDDLEWARE_ARITY = 4
/** Number of parameters a plain Express middleware / route handler exposes. */
export const REGULAR_HANDLER_ARITY = 3

export interface UseArgumentShape {
  /** True when at least one argument is a function expression / arrow with arity 4. */
  readonly hasErrorHandler: boolean
  /** True when at least one argument is a function expression / arrow with arity 3. */
  readonly hasRegularHandler: boolean
  /** True when the first argument is a string literal (path). */
  readonly firstArgIsPathLiteral: boolean
  /** True when the second argument is a plain identifier (router / imported handler). */
  readonly secondArgIsIdentifier: boolean
  /** Argument count from the AST. */
  readonly argCount: number
  /** True when some argument is a bare identifier, i.e. a handler reference that cannot be arity-checked here. */
  readonly hasIdentifierArg: boolean
}

/** Shape of a `.use(...)` call's arguments; `null` when the node or its arguments are missing. */
export function analyzeUseArguments(callExpression: unknown): UseArgumentShape | null {
  const node = asSyntaxNode(callExpression)
  if (node === null) return null
  const argsNode = findArguments(node)
  if (argsNode === null) return null

  const argChildren: SyntaxNode[] = []
  for (const child of argsNode.namedChildren) {
    if (child !== null) argChildren.push(child)
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
    firstArgIsPathLiteral: first !== undefined && isStringLiteral(first),
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

function isStringLiteral(node: SyntaxNode): boolean {
  return node.type === "string"
}
