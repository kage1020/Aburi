import type { Node } from "web-tree-sitter"
import { asFunctionValue, unwrapValue } from "./ast-helpers"
import { writtenNameSegment } from "./class-members"

export type ObjectEntry =
  | { readonly segment: string; readonly fn: Node; readonly object: null }
  | { readonly segment: string; readonly fn: null; readonly object: Node }

export function objectEntryOf(entry: Node): ObjectEntry | null {
  if (entry.type !== "method_definition" && entry.type !== "pair") return null
  const name = entry.childForFieldName(entry.type === "pair" ? "key" : "name")
  if (name === null || name.type === "private_property_identifier") return null
  const segment = writtenNameSegment(entry, name)
  if (segment === null) return null
  if (entry.type === "method_definition") return { segment, fn: entry, object: null }
  const value = entry.childForFieldName("value")
  if (value === null) return null
  const fn = asFunctionValue(value)
  if (fn !== null) {
    const body = fn.childForFieldName("body")
    return body === null || body.text.length === 0 ? null : { segment, fn, object: null }
  }
  const object = objectLiteralOf(value)
  return object === null ? null : { segment, fn: null, object }
}

export function objectLiteralOf(value: Node): Node | null {
  const inner = unwrapValue(value)
  return inner.type === "object" ? inner : null
}
