import { isQnameSegment } from "@aburi/core"
import { type CallCandidate, COMPUTED_TARGET_SEGMENT } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, firstNonCommentChild, hasErrorChild } from "./ast-helpers"
import { decodeStringLiteral, readStaticString } from "./string-escape"

export function readCall(node: Node): CallCandidate | null {
  const isNew = node.type === "new_expression"
  const callee = node.childForFieldName(isNew ? "constructor" : "function") ?? node.namedChild(0)
  if (callee === null) return null
  const shape = describeCallee(callee)
  if (shape === null) return null
  const argsNode = node.childForFieldName("arguments") ?? findChild(node, "arguments")
  const args = (argsNode?.namedChildren ?? []).filter(
    (arg): arg is Node => arg !== null && arg.type !== "comment",
  )
  return {
    target: shape.target,
    line: node.startPosition.row + 1,
    argumentCount: args.length,
    inAwait: node.parent?.type === "await_expression",
    inNew: isNew,
    literalArgs: args.map(literalOf),
    ...(shape.dynamic ? { dynamicReceiver: true } : {}),
  }
}

function literalOf(node: Node): string | null {
  switch (node.type) {
    case "number":
    case "true":
    case "false":
    case "null":
    case "undefined":
      return node.text
    case "string":
    case "template_string":
      return readStaticString(node)
    default:
      return null
  }
}

interface CalleeShape {
  readonly target: string
  readonly dynamic: boolean
  readonly opaque: boolean
}

export const TYPE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "non_null_expression",
  "as_expression",
  "satisfies_expression",
  "type_assertion",
])

const UNMODELLED_EXPRESSION: CalleeShape = {
  target: COMPUTED_TARGET_SEGMENT,
  dynamic: true,
  opaque: false,
}

const META_PROPERTIES: ReadonlySet<string> = new Set(["import.meta", "new.target"])

const LINE_BREAK = /[\n\r\u2028\u2029]/

export function wrappedExpression(node: Node): Node | null {
  return node.type === "type_assertion"
    ? (node.namedChildren.at(-1) ?? null)
    : firstNonCommentChild(node)
}

export function describeCallee(node: Node): CalleeShape | null {
  switch (node.type) {
    case "identifier":
    case "property_identifier":
      return { target: node.text, dynamic: false, opaque: false }
    case "this":
      return { target: "this", dynamic: false, opaque: false }
    case "super":
      return { target: "super", dynamic: false, opaque: false }
    case "import":
      return { target: "import", dynamic: false, opaque: false }
    case "meta_property":
      return META_PROPERTIES.has(node.text)
        ? { target: node.text, dynamic: false, opaque: false }
        : UNMODELLED_EXPRESSION
    case "member_expression": {
      const object = node.childForFieldName("object")
      const property = node.childForFieldName("property")
      const objectShape = object !== null ? describeCallee(object) : null
      const propertyStr = property !== null ? property.text : null
      if (objectShape === null || propertyStr === null) return null
      return {
        target: `${objectShape.target}.${propertyStr}`,
        dynamic: objectShape.dynamic,
        opaque: objectShape.opaque,
      }
    }
    case "subscript_expression": {
      const object = node.childForFieldName("object")
      if (object === null) return null
      const inner = describeCallee(object)
      if (inner === null) return null
      const segment = subscriptSegment(node)
      if (segment === null) {
        return {
          target: `${inner.target}.${COMPUTED_TARGET_SEGMENT}`,
          dynamic: true,
          opaque: false,
        }
      }
      return {
        target: `${inner.target}.${segment}`,
        dynamic: inner.dynamic,
        opaque: inner.opaque,
      }
    }
    case "parenthesized_expression": {
      const innerNode = node.namedChild(0)
      if (innerNode === null) return null
      const inner = describeCallee(innerNode)
      if (inner === null) return null
      return { target: inner.target, dynamic: inner.dynamic || inner.opaque, opaque: false }
    }
    case "call_expression": {
      const innerNode = node.childForFieldName("function")
      if (innerNode === null) return null
      const inner = describeCallee(innerNode)
      if (inner === null) return null
      return { target: inner.target, dynamic: true, opaque: false }
    }
    default:
      if (TYPE_WRAPPER_TYPES.has(node.type)) return describeTypeWrapper(node)
      return node.text.length > 0 ? UNMODELLED_EXPRESSION : null
  }
}

function describeTypeWrapper(node: Node): CalleeShape | null {
  const innerNode = wrappedExpression(node)
  if (innerNode === null) return null
  const inner = describeCallee(innerNode)
  if (inner === null) return null
  if (inner.dynamic) return { target: inner.target, dynamic: true, opaque: false }
  if (LINE_BREAK.test(node.text)) return UNMODELLED_EXPRESSION
  if (node.text.split(".").some((segment) => segment.length === 0)) return UNMODELLED_EXPRESSION
  return { target: node.text, dynamic: false, opaque: true }
}

function subscriptSegment(node: Node): string | null {
  if (hasErrorChild(node)) return null
  const index = node.childForFieldName("index")
  if (index === null) return null
  if (index.type !== "string" && index.type !== "template_string") return null
  const { value, whole } = decodeStringLiteral(index)
  return whole && isQnameSegment(value) ? value : null
}
