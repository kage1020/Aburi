import { isQnameSegment } from "@aburi/core"
import type { Node } from "web-tree-sitter"
import { functionValueOf, hasChildOfType, hasErrorChild, nameFieldText } from "./ast-helpers"
import { decodeStringLiteral } from "./string-escape"

const CONSTRUCTION_SEGMENT = "constructor"

export function memberNameSegment(member: Node): string | null {
  return writtenNameSegment(member, member.childForFieldName("name"))
}

export function writtenNameSegment(owner: Node, name: Node | null): string | null {
  if (hasErrorChild(owner)) return null
  if (name === null) return null
  if (name.type === "property_identifier") return admitSegment(name.text)
  if (name.type === "private_property_identifier") return admitSegment(name.text, true)
  if (name.type !== "string") return null
  const { value, whole } = decodeStringLiteral(name)
  return whole ? admitSegment(value) : null
}

function admitSegment(candidate: string, privateName = false): string | null {
  return isQnameSegment(candidate, { privateName }) ? candidate : null
}

/**
 * The qualified-name segment of the member Symbol this class-body node declares, or null when
 * it declares none.
 *
 * **One reader, one answer.** Extraction asks this to decide what to emit and `walkBody` asks
 * it to decide whose body a member's calls and rules belong to; the moment they disagree a
 * body is recorded twice or not at all. It answers with the segment rather than a boolean so
 * extraction does not re-derive what admission already computed — and so a builder cannot be
 * handed a name the id builder then refuses. The *arguments* have to agree too: `classNode` is
 * the class the member is written in, which the walk reads off `body.parent` — a Symbol's
 * `fullNode` is its **leading** declaration and need not be the class at all (`const C = 1`
 * beside `class C {}` folds into one Symbol whose `fullNode` is the `lexical_declaration`).
 *
 * Only a **named** class has member Symbols: the only unnamed form the statement walk reaches
 * is an anonymous default export, where `<default>` is reserved for the class itself and
 * `<default>.m` is not a qualified name the id builder accepts (`ir-schema.md`).
 *
 * Four member shapes qualify. A `method_definition` is a member when `memberNameSegment` gives
 * it one. A field holding a function is a member because calling it is what runs the body
 * (`functionValuedField`). The other two are the shapes a member with **no body of its own**
 * is written in:
 *
 * - `abstract_method_signature` is a member. The language forbids an implementation beside it,
 *   so nothing else in the class declares `doIt`, and skipping it left an abstract class
 *   reporting only the methods it happened to implement.
 * - `method_signature` declares the member wherever it is written. In an ambient class it is
 *   the member's whole declaration: there are no implementations to defer to, and skipping it
 *   left `export declare class` with no methods at all. In an ordinary class body it is an
 *   overload, and folds into the implementation beside it, which leads (LP8q) — as a top-level
 *   `function_signature` does.
 *
 * So this answers which member a node declares, not whether that member gets a Symbol: which
 * declaration leads is extraction's question (`foldMemberGroup`), and a class body of overload
 * signatures with no implementation has none to lead and no member Symbol, which is what `tsc`
 * calls TS2391 anyway. The walk's answer does not depend on that: a signature has no body for
 * a member Symbol to carry, so `walkBody` reads it whole on the class either way.
 */
export function memberSymbolSegment(classNode: Node, member: Node): string | null {
  if (nameFieldText(classNode) === null) return null
  const segment = memberNameSegment(member)
  if (segment === null) return null
  if (member.type === "method_definition") return segment
  if (member.type === "abstract_method_signature") return segment
  if (member.type === "method_signature") return segment
  return functionValuedField(member) === null ? null : segment
}

export function functionValuedField(member: Node): Node | null {
  if (member.type !== "public_field_definition") return null
  const segment = memberNameSegment(member)
  if (segment === null || segment === CONSTRUCTION_SEGMENT) return null
  return functionValueOf(member)
}

export function isConstructorMember(member: Node): boolean {
  if (hasChildOfType(member, "static")) return false
  return memberNameSegment(member) === CONSTRUCTION_SEGMENT
}

export function hasPrivateName(member: Node): boolean {
  return member.childForFieldName("name")?.type === "private_property_identifier"
}
