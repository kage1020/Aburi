import { calleeName, type SyntaxNode, unwrapValue } from "@aburi/core"
import { COMPUTED_TARGET_SEGMENT } from "@aburi/types"
import { isPathLiteral, writtenChildren } from "./ast-helpers"
import { EXPRESS_MIDDLEWARE_METHOD } from "./middleware"
import { handlerArguments, hasRouteArguments, isRouteMethod } from "./routes"

const UNREAD_ARGUMENT = "…"

// An inline function is left out: its body is the registration's own, and already read as such.
export function registrationMiddleware(call: SyntaxNode): string[] {
  return registrationsInChain(call).flatMap((registration) => {
    const leaf = calleeName(registration)?.leaf
    if (leaf === EXPRESS_MIDDLEWARE_METHOD) return named(useArguments(registration))
    if (leaf !== undefined && isRouteMethod(leaf) && hasRouteArguments(registration)) {
      return named(handlerArguments(registration).flatMap(flattened).slice(0, -1))
    }
    return []
  })
}

function registrationsInChain(call: SyntaxNode): SyntaxNode[] {
  const chain: SyntaxNode[] = []
  let cursor: SyntaxNode | null = call
  while (cursor !== null) {
    const step: SyntaxNode = unwrapValue(cursor)
    if (step.type === "call_expression") {
      chain.push(step)
      cursor = step.childForFieldName("function")
    } else if (step.type === "member_expression") {
      cursor = step.childForFieldName("object")
    } else {
      cursor = null
    }
  }
  return chain.reverse()
}

function useArguments(call: SyntaxNode): SyntaxNode[] {
  const args = writtenChildren(call.childForFieldName("arguments"))
  const [first] = args
  return (first !== undefined && isPathLiteral(first) ? args.slice(1) : args).flatMap(flattened)
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
  if (key.type !== "string") return COMPUTED_TARGET_SEGMENT
  const parts = writtenChildren(key)
  if (parts.length === 0 || parts.some((part) => part.type !== "string_fragment")) {
    return COMPUTED_TARGET_SEGMENT
  }
  return parts.map((part) => part.text).join("")
}

// A factory's arguments decide what its middleware lets through (`requireRole("admin")`), so
// literals and names are kept; anything longer is not a name and is not spelled out.
function argumentOf(node: SyntaxNode): string {
  const value = unwrapValue(node)
  switch (value.type) {
    case "string":
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
