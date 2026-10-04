import { asSyntaxNode, type SyntaxNode } from "@aburi/core"
import { isPathLiteral, unwrapValue, writtenChildren } from "./ast-helpers"

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
  /**
   * True when the first argument is a literal string (path): quoted, or a backtick with no
   * substitution, read through the wrappers a value is read through (`isPathLiteral`).
   */
  readonly firstArgIsPathLiteral: boolean
  /** True when the second argument is an identifier (router / imported handler). */
  readonly secondArgIsIdentifier: boolean
  /** Argument count from the AST. */
  readonly argCount: number
  /** True when some argument is an identifier, i.e. a handler reference that cannot be arity-checked here. */
  readonly hasIdentifierArg: boolean
}

/**
 * Shape of a `.use(...)` call's arguments; `null` when the node or its arguments are missing.
 *
 * Each argument is read through the wrappers a value is read through (`unwrapValue`), as
 * `@aburi/lang-typescript` reads it for the registration's body and name: read bare, the
 * handler in `app.use(logger as RequestHandler)` was no identifier and the call no middleware,
 * and `app.use("/api", apiRouter as Router)`, named by its path, was no mount.
 */
export function analyzeUseArguments(callExpression: unknown): UseArgumentShape | null {
  const node = asSyntaxNode(callExpression)
  if (node === null) return null
  const argsNode = findArguments(node)
  if (argsNode === null) return null

  const argChildren = writtenChildren(argsNode)

  let hasErrorHandler = false
  let hasRegularHandler = false
  let hasIdentifierArg = false

  for (const written of argChildren) {
    const arg = unwrapValue(written)
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
    secondArgIsIdentifier: second !== undefined && isIdentifier(unwrapValue(second)),
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
