import type { Node } from "web-tree-sitter"
import { asFunctionValue, unwrapValue } from "./ast-helpers"
import { writtenNameSegment } from "./class-members"

/**
 * What one entry of an object literal declares under the binding that holds the object: a
 * member with a Symbol of its own, an object whose entries are read the same way one segment
 * further down, or — answered by `objectEntryOf` with null — nothing, which leaves the entry
 * on the binding's own walk.
 *
 * `fn` is the node that has the member's `body` and `parameters`: the `method_definition`
 * itself, or the function a `pair` holds. Exactly one of `fn` and `object` is set.
 */
export type ObjectEntry =
  | { readonly segment: string; readonly fn: Node; readonly object: null }
  | { readonly segment: string; readonly fn: null; readonly object: Node }

/**
 * How one entry of an object literal is read, or null when it declares nothing of its own.
 *
 * **One reader, one answer**, as `memberSymbolSegment` is for a class: extraction asks this to
 * decide which members to emit and `walkBody` asks it to decide which bodies the binding stops
 * carrying, so the two cannot disagree about whose body an entry's calls belong to.
 *
 * Two shapes are members. A `method_definition` — `post() {}`, and the accessor, generator and
 * `async` spellings, the node a class body uses — and a `pair` holding a function, `get: () =>
 * …`, by the function set a class field and a module-level binding already use (LP7a). Defining
 * the object creates the closure and does not enter it, so the body is what calling the
 * property runs, which is LP20f's reason for a class field.
 *
 * A `pair` holding another object literal is read one level further down, at any depth:
 * `api.v1.get` is the path the source calls it by. The depth costs one Symbol per **function**
 * the source writes and nothing per other value, so a deep configuration object of strings and
 * numbers mints none. The object in between declares no Symbol, as nothing is written there to
 * walk.
 *
 * The name gate is a class member's (`writtenNameSegment`): a computed key, a number, and a
 * quoted key that is not an identifier have no segment, and their entry stays on the binding
 * (LP20c). A `#`-private name has none either. It is a SyntaxError outside a class body, the
 * grammar parses it anyway, and the segment it would take is the private member's.
 *
 * Everything else is null: a shorthand (`{ a }`) reads a binding declared elsewhere, a spread
 * copies one, a `pair` holding any other value is evaluated when the object is.
 */
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
  if (fn !== null) return { segment, fn, object: null }
  const object = objectLiteralOf(value)
  return object === null ? null : { segment, fn: null, object }
}

/**
 * The object literal `value` is, reading through the wrappers that say nothing about it (LP7a),
 * or null. `as const` and `satisfies Api` are how a handler map is ordinarily written, and the
 * binding's initializer and a nested entry's value are the same question.
 */
export function objectLiteralOf(value: Node): Node | null {
  const inner = unwrapValue(value)
  return inner.type === "object" ? inner : null
}
