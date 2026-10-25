import { isQnameSegment } from "@aburi/core"
import type { MergedDeclaration } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { functionValueOf, hasChildOfType, hasErrorChild, nameFieldText } from "./ast-helpers"
import { wrappedFunctions } from "./call-symbols"
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

export function memberSymbolSegment(classNode: Node, member: Node): string | null {
  if (nameFieldText(classNode) === null) return null
  const segment = memberNameSegment(member)
  if (segment === null) return null
  if (member.type === "method_definition") return segment
  if (member.type === "abstract_method_signature") return segment
  if (member.type === "method_signature") return segment
  return functionValuedField(member) === null ? null : segment
}

/** A function a field holds runs when the member is called, not when the class is constructed. */
export type HeldFunction =
  | { readonly kind: "function"; readonly fn: Node }
  | {
      readonly kind: "handed-to-a-call"
      readonly handlers: readonly [MergedDeclaration<Node>, ...MergedDeclaration<Node>[]]
    }

export function functionValuedField(member: Node): HeldFunction | null {
  if (member.type !== "public_field_definition") return null
  const segment = memberNameSegment(member)
  if (segment === null || segment === CONSTRUCTION_SEGMENT) return null
  return functionAFieldHolds(member)
}

export function functionAFieldHolds(field: Node): HeldFunction | null {
  const fn = functionValueOf(field)
  if (fn !== null) return { kind: "function", fn }
  const value = field.childForFieldName("value")
  const [lead, ...rest] = value === null ? [] : wrappedFunctions(value, field)
  return lead === undefined ? null : { kind: "handed-to-a-call", handlers: [lead, ...rest] }
}

export function heldFunctionBodies(held: HeldFunction): Node[] {
  if (held.kind === "handed-to-a-call") return held.handlers.flatMap((h) => h.bodyNode ?? [])
  const body = held.fn.childForFieldName("body")
  return body === null ? [] : [body]
}

export function isConstructorMember(member: Node): boolean {
  if (hasChildOfType(member, "static")) return false
  return memberNameSegment(member) === CONSTRUCTION_SEGMENT
}

export function hasPrivateName(member: Node): boolean {
  return member.childForFieldName("name")?.type === "private_property_identifier"
}
