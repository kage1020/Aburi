import { asSyntaxNode, type SyntaxNode } from "@aburi/core"
import { isPathLiteral, unwrapValue, writtenChildren } from "./ast-helpers"

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

/**
 * Whether a call's arguments have the shape of a route registration: the first argument is
 * taken as the path, and at least one argument after it must be handler-shaped
 * (`isHandlerShaped`). The method name alone is shared vocabulary — `map.delete(key)`,
 * `url.searchParams.delete("x")`, `settings.get("port")` and Express's own settings getter
 * `app.get("env")` all end in a route method — and none of them passes a handler.
 *
 * The path's shape is not checked, so `app.get(ROUTES.users, h)` stays a route, and so does
 * `cache.put(key, value)`. A data argument in the handler's place does not count, so
 * `axios.post(url, { id })` stays out. An identifier can name data as well as a function;
 * nothing in the tree tells them apart, and the import anchor still decides the confidence.
 *
 * Two shapes leave no path to skip, and every argument is read as a handler there: a chain that
 * has written the path already (`hasRouteCallUpTheChain`), whose methods take handlers alone
 * (`app.route("/users").get(listUsers)`), and a spread written first (`app.get(...routeArgs)`),
 * which can carry the path and the handlers together. The price of the second is that
 * `cache.delete(...keys)` is read the same way.
 *
 * A value that is not a syntax node answers `false` as well: it is no call, so it registers
 * nothing.
 */
export function hasRouteArguments(callExpression: unknown): boolean {
  const node = asSyntaxNode(callExpression)
  if (node === null) return false
  const args = writtenChildren(node.childForFieldName("arguments"))
  const noPathToSkip = hasRouteCallUpTheChain(node) || args[0]?.type === "spread_element"
  return (noPathToSkip ? args : args.slice(1)).some(isHandlerShaped)
}

/**
 * Whether an argument names or writes a function, read through the wrappers a value is read
 * through (`handler as RequestHandler`, `handler!`):
 *
 * - an inline function, an identifier or a member path (`listUsers`, `users.list`,
 *   `handlers[method]`);
 * - an array or a spread of those, which Express flattens into handlers (`[auth, listUsers]`,
 *   `...handlers`);
 * - a choice between them, written as a ternary or as a fallback (`isProd ? cached : live`,
 *   `custom || defaultHandler`, `options.handler ?? fallback`). No other operator writes one:
 *   `count + 1` and `mode === "dev"` compute a value, and `enabled && handler` hands Express
 *   `false` when it is off;
 * - a call, which in a registration is a handler factory or wrapper
 *   (`passport.authenticate("google", { scope })`, `asyncHandler(listUsers)`,
 *   `users.list.bind(users)`). What a call is handed is not examined, because a factory is
 *   often handed options alone (`createHandler({ schema })`). The price is that
 *   `cache.put(key, JSON.stringify(value))` stays a route, as `cache.put(key, value)` does.
 *
 * A construction is not one (`new AsyncHandler(listUsers)`): `new` ordinarily makes an object,
 * which Express cannot call, and an object handed to a route method is ordinarily data
 * (`axios.post(url, new FormData(form))`). Neither is an awaited value (`await makeHandler()`),
 * ordinarily data as well (`cache.put(key, await load())`), nor an old-style assertion
 * (`<RequestHandler>listUsers`), which `unwrapValue` does not read. A registration whose only
 * handler is written one of those ways is not classified.
 */
function isHandlerShaped(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  switch (value.type) {
    case "arrow_function":
    case "function_expression":
    case "identifier":
    case "member_expression":
    case "subscript_expression":
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
    default:
      return false
  }
}

/** The operators that answer with one of their two operands as it is. */
const FALLBACK_OPERATORS: ReadonlySet<string> = new Set(["||", "??"])

function eitherIsHandlerShaped(a: SyntaxNode | null, b: SyntaxNode | null): boolean {
  return [a, b].some((branch) => branch !== null && isHandlerShaped(branch))
}

/** `app.route(path)`: Express's own way of writing the path once for several methods. */
const ROUTE_CHAIN_METHOD = "route"

/**
 * Whether the receiver chain calls `.route(path)`, as `app.route("/users").get(h).post(h2)`
 * does, on any receiver and at any depth.
 *
 * Every step is read through the wrappers a value is read through, as `@aburi/lang-typescript`
 * reads the same chain for the registration's name: `app.route("/users")!.get(listUsers)` is
 * named by `/users`, and is the route its name says.
 *
 * `route` is shared vocabulary as well, so the path has to be written there, as a literal
 * beginning with `/`: a builder's `db.route("users").delete(recordId)` is not a route. The price
 * is `app.route(USERS_PATH).get(listUsers)`, whose path is a name the tree cannot read.
 */
function hasRouteCallUpTheChain(call: SyntaxNode): boolean {
  let cursor = call.childForFieldName("function")
  while (cursor !== null) {
    const step = unwrapValue(cursor)
    if (step.type === "member_expression") {
      cursor = step.childForFieldName("object")
      continue
    }
    if (step.type !== "call_expression") return false
    const callee = step.childForFieldName("function")
    if (callee !== null && isRouteCall(unwrapValue(callee), step)) return true
    cursor = callee
  }
  return false
}

/** `call` is `<receiver>.route(path)`, its first argument a path `writesRoutePath` accepts. */
function isRouteCall(callee: SyntaxNode, call: SyntaxNode): boolean {
  if (callee.type !== "member_expression") return false
  if (callee.childForFieldName("property")?.text !== ROUTE_CHAIN_METHOD) return false
  const [path] = writtenChildren(call.childForFieldName("arguments"))
  return path !== undefined && writesRoutePath(path)
}

/** A literal string (`isPathLiteral`) whose first character inside the quotes is `/`. */
function writesRoutePath(node: SyntaxNode): boolean {
  return isPathLiteral(node) && unwrapValue(node).text.charAt(1) === "/"
}
