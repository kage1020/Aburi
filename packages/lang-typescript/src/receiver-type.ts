import type { Node } from "web-tree-sitter"
import { firstNonCommentChild, hasChildOfType } from "./ast-helpers"

const THIS_REBINDING_FUNCTIONS: ReadonlySet<string> = new Set([
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
])

const PARAMETER_PROPERTY_MODIFIERS = ["accessibility_modifier", "override_modifier", "readonly"]

interface ThisScope {
  readonly classBody: Node
  readonly isStatic: boolean
}

// Only `this.<field>` is read: the class that declares the field is found by walking up, where a
// plain name would need a scope resolver to tell its declaration from what shadows it.
export function receiverTypeOf(callee: Node): string | null {
  if (callee.type !== "member_expression") return null
  const receiver = callee.childForFieldName("object")
  if (receiver?.type !== "member_expression") return null
  if (receiver.childForFieldName("object")?.type !== "this") return null
  const field = receiver.childForFieldName("property")
  if (field === null) return null
  const scope = thisScope(receiver)
  return scope === null ? null : declaredType(scope, field.text)
}

function thisScope(from: Node): ThisScope | null {
  let child = from
  for (let node = from.parent; node !== null; child = node, node = node.parent) {
    if (THIS_REBINDING_FUNCTIONS.has(node.type)) return null
    if (!bindsThisFor(node, child)) continue
    const classBody = node.parent
    if (classBody?.type !== "class_body") return null
    const isStatic = node.type === "class_static_block" || hasChildOfType(node, "static")
    return { classBody, isStatic }
  }
  return null
}

// A member's name and decorators are evaluated outside it, with the `this` around the class.
function bindsThisFor(member: Node, child: Node): boolean {
  switch (member.type) {
    case "method_definition":
      return [member.childForFieldName("body"), member.childForFieldName("parameters")].some(
        (part) => part?.id === child.id,
      )
    case "public_field_definition":
      return member.childForFieldName("value")?.id === child.id
    case "class_static_block":
      return true
    default:
      return false
  }
}

function declaredType(scope: ThisScope, name: string): string | null {
  for (const member of scope.classBody.namedChildren) {
    if (member === null) continue
    if (member.type === "public_field_definition") {
      if (member.childForFieldName("name")?.text !== name) continue
      if (hasChildOfType(member, "static") !== scope.isStatic) continue
      return namedType(member)
    }
    if (!scope.isStatic && isConstructor(member)) {
      const property = parameterProperty(member, name)
      if (property !== null) return namedType(property)
    }
  }
  return null
}

function isConstructor(member: Node): boolean {
  return (
    member.type === "method_definition" &&
    member.childForFieldName("name")?.text === "constructor" &&
    !hasChildOfType(member, "static")
  )
}

function parameterProperty(construction: Node, name: string): Node | null {
  const parameters = construction.childForFieldName("parameters")?.namedChildren ?? []
  for (const parameter of parameters) {
    if (parameter === null) continue
    if (parameter.childForFieldName("pattern")?.text !== name) continue
    const isProperty = PARAMETER_PROPERTY_MODIFIERS.some((modifier) =>
      hasChildOfType(parameter, modifier),
    )
    return isProperty ? parameter : null
  }
  return null
}

function namedType(declaration: Node): string | null {
  const annotation = declaration.childForFieldName("type")
  const type = annotation === null ? null : firstNonCommentChild(annotation)
  return type === null ? null : typeName(type)
}

function typeName(type: Node): string | null {
  switch (type.type) {
    case "type_identifier":
      return type.text
    case "nested_type_identifier":
      return type.text.replace(/\s+/g, "")
    case "generic_type": {
      const name = type.childForFieldName("name")
      return name === null ? null : typeName(name)
    }
    default:
      return null
  }
}
