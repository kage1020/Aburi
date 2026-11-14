import {
  calleeName,
  chainCalls,
  middlewareNames,
  type SyntaxNode,
  unwrapValue,
  writtenChildren,
} from "@aburi/core"
import { EXPRESS_MIDDLEWARE_METHOD } from "./middleware"
import { handlerArguments, hasRouteArguments, isRouteMethod } from "./routes"

export function registrationMiddleware(call: SyntaxNode): string[] {
  const chain = chainCalls(call).toReversed()
  return chain.flatMap((registration, index) => {
    const leaf = calleeName(registration)?.leaf
    if (leaf === EXPRESS_MIDDLEWARE_METHOD) return middlewareNames(useArguments(registration))
    if (leaf === undefined || !isRouteMethod(leaf) || !hasRouteArguments(registration)) return []
    const handlers = handlerArguments(registration).flatMap(flattened)
    const guardsLaterRoutes =
      leaf === ALL_METHODS && chain.slice(index + 1).some(isRouteRegistration)
    return middlewareNames(guardsLaterRoutes ? handlers : handlers.slice(0, -1))
  })
}

// An `.all(...)` ahead of other methods in one chain runs first for each of them, so every
// handler it takes passes the request on rather than answering it.
const ALL_METHODS = "all"

function isRouteRegistration(call: SyntaxNode): boolean {
  const leaf = calleeName(call)?.leaf
  return leaf !== undefined && isRouteMethod(leaf) && hasRouteArguments(call)
}

function useArguments(call: SyntaxNode): SyntaxNode[] {
  const args = writtenChildren(call.childForFieldName("arguments"))
  const [first] = args
  return (first !== undefined && isUsePath(first) ? args.slice(1) : args).flatMap(flattened)
}

const USE_PATH_TYPES: ReadonlySet<string> = new Set(["string", "template_string", "regex"])

// Express reads an array's first entry, at any depth, to tell a path from a handler, and an
// empty array is a path.
function isUsePath(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  if (value.type !== "array") return USE_PATH_TYPES.has(value.type)
  const [first] = writtenChildren(value)
  return first === undefined || isUsePath(first)
}

/** Express flattens arrays of handlers, at any depth and through a spread of one. */
function flattened(node: SyntaxNode): SyntaxNode[] {
  const value = unwrapValue(node)
  if (value.type === "array") return writtenChildren(value).flatMap(flattened)
  if (value.type === "spread_element") {
    const [spread] = writtenChildren(value)
    if (spread !== undefined && unwrapValue(spread).type === "array") return flattened(spread)
  }
  return [value]
}
