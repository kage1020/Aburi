import { COMPUTED_TARGET_SEGMENT } from "@aburi/types"
import { readStaticString } from "./string-literal"
import { type SyntaxNode, unwrapValue, writtenChildren } from "./syntax-node"

const UNREAD_ARGUMENT = "…"

/**
 * What a framework is handed to run ahead of a handler, by name, in the order given. An inline
 * function is left out: its body is the registration's own, and already read as such.
 */
export function middlewareNames(handlers: readonly SyntaxNode[]): string[] {
  return handlers.flatMap((written) => {
    const handler = unwrapValue(written)
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
