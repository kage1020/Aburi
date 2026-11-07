import {
  asSyntaxNode,
  chainCalls,
  type SyntaxNode,
  unwrapValue,
  writtenChildren,
} from "@aburi/core"
import { isPathLiteral } from "./ast-helpers"

/** Route-registering method names, lower-case to match `member_expression` property text verbatim. */
export const EXPRESS_ROUTE_METHODS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
])

export function isRouteMethod(leaf: string): boolean {
  return EXPRESS_ROUTE_METHODS.has(leaf)
}

// A route method's name is shared vocabulary (`settings.get("port")`, Express's own
// `app.get("env")`): a handler after the path is what makes the call a registration.
export function hasRouteArguments(callExpression: unknown): boolean {
  const node = asSyntaxNode(callExpression)
  if (node === null) return false
  return handlerArguments(node).some(isHandlerShaped)
}

export function handlerArguments(call: SyntaxNode): SyntaxNode[] {
  const args = writtenChildren(call.childForFieldName("arguments"))
  // A `.route(path)` chain has written the path already, and a leading spread may carry it.
  const noPathToSkip = hasRouteCallUpTheChain(call) || args[0]?.type === "spread_element"
  return noPathToSkip ? args : args.slice(1)
}

function isHandlerShaped(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  switch (value.type) {
    // Express calls a handler and never iterates what it returns, so a generator is not one here.
    case "arrow_function":
    case "function_expression":
    case "identifier":
    case "member_expression":
    case "subscript_expression":
    // What a call is handed is not examined: a handler factory is often handed options alone.
    case "call_expression":
      return true
    case "array":
    case "spread_element":
      return writtenChildren(value).some(isHandlerShaped)
    case "ternary_expression":
      return eitherIsHandlerShaped(
        value.childForFieldName("consequence"),
        value.childForFieldName("alternative"),
      )
    case "binary_expression":
      return (
        FALLBACK_OPERATORS.has(value.childForFieldName("operator")?.type ?? "") &&
        eitherIsHandlerShaped(value.childForFieldName("left"), value.childForFieldName("right"))
      )
    // `new` and `await` ordinarily hand a route method data (`new FormData(form)`, `await load()`).
    default:
      return false
  }
}

// `&&` is left out: `enabled && handler` hands Express `false` when it is off.
const FALLBACK_OPERATORS: ReadonlySet<string> = new Set(["||", "??"])

function eitherIsHandlerShaped(a: SyntaxNode | null, b: SyntaxNode | null): boolean {
  return [a, b].some((branch) => branch !== null && isHandlerShaped(branch))
}

const ROUTE_CHAIN_METHOD = "route"

function hasRouteCallUpTheChain(call: SyntaxNode): boolean {
  return chainCalls(call)
    .slice(1)
    .some((step) => {
      const callee = step.childForFieldName("function")
      return callee !== null && isRouteCall(unwrapValue(callee), step)
    })
}

function isRouteCall(callee: SyntaxNode, call: SyntaxNode): boolean {
  if (callee.type !== "member_expression") return false
  if (callee.childForFieldName("property")?.text !== ROUTE_CHAIN_METHOD) return false
  const [path] = writtenChildren(call.childForFieldName("arguments"))
  return path !== undefined && writesRoutePath(path)
}

// `route` is shared vocabulary too (`db.route("users")`): only a literal path starting `/` counts.
function writesRoutePath(node: SyntaxNode): boolean {
  return isPathLiteral(node) && unwrapValue(node).text.charAt(1) === "/"
}
