import {
  calleeName,
  chainCalls,
  readStaticString,
  type SyntaxNode,
  unwrapValue,
  writtenChildren,
} from "@aburi/core"
import { COMPUTED_TARGET_SEGMENT } from "@aburi/types"
import { EXPRESS_MIDDLEWARE_METHOD } from "./middleware"
import { handlerArguments, hasRouteArguments, isRouteMethod } from "./routes"

const UNREAD_ARGUMENT = "…"

// An inline function is left out: its body is the registration's own, and already read as such.
export function registrationMiddleware(call: SyntaxNode): string[] {
  const chain = chainCalls(call).reverse()
  return chain.flatMap((registration, index) => {
    const leaf = calleeName(registration)?.leaf
    if (leaf === EXPRESS_MIDDLEWARE_METHOD) return named(useArguments(registration))
    if (leaf === undefined || !isRouteMethod(leaf) || !hasRouteArguments(registration)) return []
    const handlers = handlerArguments(registration).flatMap(flattened)
    const guardsLaterRoutes =
      leaf === ALL_METHODS && chain.slice(index + 1).some(isRouteRegistration)
    return named(guardsLaterRoutes ? handlers : handlers.slice(0, -1))
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

function named(handlers: readonly SyntaxNode[]): string[] {
  return handlers.flatMap((handler) => {
    if (handler.type === "arrow_function" || handler.type === "function_expression") return []
    if (handler.type !== "spread_element") return [nameOf(handler)]
    const [spread] = writtenChildren(handler)
    return [`...${spread === undefined ? COMPUTED_TARGET_SEGMENT : nameOf(spread)}`]
  })
}

// Composed from the tree rather than copied from the text, which would carry the line breaks
// and comments the registration was written with into the fingerprint.
function nameOf(node: SyntaxNode): string {
  const value = unwrapValue(node)
  switch (value.type) {
    case "identifier":
    case "this":
      return value.text
    case "member_expression":
    case "subscript_expression": {
      const object = value.childForFieldName("object")
      const key = memberKey(value)
      return `${object === null ? COMPUTED_TARGET_SEGMENT : nameOf(object)}.${key}`
    }
    case "call_expression": {
      const callee = value.childForFieldName("function")
      const args = writtenChildren(value.childForFieldName("arguments")).map(argumentOf)
      return `${callee === null ? COMPUTED_TARGET_SEGMENT : nameOf(callee)}(${args.join(", ")})`
    }
    default:
      return COMPUTED_TARGET_SEGMENT
  }
}

function memberKey(member: SyntaxNode): string {
  if (member.type === "member_expression") {
    const property = member.childForFieldName("property")?.text ?? ""
    return property.length > 0 ? property : COMPUTED_TARGET_SEGMENT
  }
  const index = member.childForFieldName("index")
  if (index === null) return COMPUTED_TARGET_SEGMENT
  const key = unwrapValue(index)
  if (key.type === "number") return key.text
  const text = readStaticString(key)
  return text === null || text.length === 0 ? COMPUTED_TARGET_SEGMENT : text
}

// A factory's arguments decide what its middleware lets through (`requireRole("admin")`), so
// literals and names are kept; anything longer is not a name and is not spelled out. A string
// is rewritten in one quote style, so a formatter flipping quotes leaves the name as it was.
function argumentOf(node: SyntaxNode): string {
  const value = unwrapValue(node)
  switch (value.type) {
    case "string":
    case "template_string": {
      const text = readStaticString(value)
      return text === null ? UNREAD_ARGUMENT : JSON.stringify(text)
    }
    case "number":
    case "true":
    case "false":
    case "null":
    case "undefined":
      return value.text
    case "identifier":
    case "this":
    case "member_expression":
    case "subscript_expression":
    case "call_expression":
      return nameOf(value)
    default:
      return UNREAD_ARGUMENT
  }
}
