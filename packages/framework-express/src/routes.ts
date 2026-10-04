import { asSyntaxNode, type SyntaxNode } from "@aburi/core"
import { unwrapValue } from "./middleware"

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
 * Whether a call's arguments have the shape of a route registration: a path, then at least
 * one handler. The method name alone is shared vocabulary — `map.delete(key)`,
 * `url.searchParams.delete("x")`, `settings.get("port")` and Express's own settings getter
 * `app.get("env")` all end in a route method — and none of them passes a handler.
 *
 * The path is the first argument, unless the chain wrote it already: on
 * `app.route("/users").get(listUsers)` the route's methods take handlers alone, so there one
 * argument is enough. A handler is any other argument that names or writes a function
 * (`isHandlerShaped`). A data argument does not count, so `axios.post(url, { id })` stays out.
 * An identifier can name data as well as a function; nothing in the tree tells them apart,
 * and the import anchor still decides the confidence.
 */
export function hasRouteArguments(callExpression: unknown): boolean {
  const node = asSyntaxNode(callExpression)
  if (node === null) return false
  const args = writtenChildren(node.childForFieldName("arguments"))
  if (hasRouteCallUpTheChain(node)) return args.some(isHandlerShaped)
  // The first argument is the path, so a call handed one argument has no handler.
  return args.slice(1).some(isHandlerShaped)
}

/**
 * An inline function, an identifier or a member path (`listUsers`, `users.list`,
 * `handlers[method]`), read through the wrappers a value is read through
 * (`handler as RequestHandler`); an array or a spread of those, which Express flattens into
 * handlers (`[auth, listUsers]`, `...handlers`), or a choice between them
 * (`isProd ? cached : live`); and a call, which in a registration is a handler factory or
 * wrapper: `passport.authenticate("google", { scope })`, `createHandler({ schema })`,
 * `asyncHandler(listUsers)`, `users.list.bind(users)`. A call counts whatever it is handed,
 * because a factory is often handed options alone, as the first two are. The price is that
 * `cache.put(key, JSON.stringify(value))` stays a route, as `cache.put(key, value)` does.
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
      return [value.childForFieldName("consequence"), value.childForFieldName("alternative")].some(
        (branch) => branch !== null && isHandlerShaped(branch),
      )
    default:
      return false
  }
}

/** `app.route(path)`: Express's own way of writing the path once for several methods. */
const ROUTE_CHAIN_METHOD = "route"

/** Whether the receiver chain calls `.route(…)`, as `app.route("/users").get(h).post(h2)` does. */
function hasRouteCallUpTheChain(call: SyntaxNode): boolean {
  let cursor = call.childForFieldName("function")
  while (cursor !== null) {
    if (cursor.type === "member_expression") {
      cursor = cursor.childForFieldName("object")
      continue
    }
    if (cursor.type !== "call_expression") return false
    const callee = cursor.childForFieldName("function")
    if (
      callee?.type === "member_expression" &&
      callee.childForFieldName("property")?.text === ROUTE_CHAIN_METHOD &&
      writtenChildren(cursor.childForFieldName("arguments")).length > 0
    ) {
      return true
    }
    cursor = callee
  }
  return false
}

/** `node`'s named children less comments, which the grammar hangs wherever they were written. */
function writtenChildren(node: SyntaxNode | null): SyntaxNode[] {
  if (node === null) return []
  return node.namedChildren.filter(
    (child): child is SyntaxNode => child !== null && child.type !== "comment",
  )
}
