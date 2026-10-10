import { type Decorator, UNNAMED_DECORATOR } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { firstNonCommentChild, hasErrorChild } from "./ast-helpers"

export function readDecorators(declaration: Node): Decorator[] {
  return collectDecoratorNodes(declaration)
    .map(readDecorator)
    .filter((d): d is Decorator => d !== null)
}

function collectDecoratorNodes(declaration: Node): Node[] {
  const found = [
    ...precedingDecorators(declaration),
    ...declaration.childrenForFieldName("decorator"),
  ]
  return found.sort((a, b) => a.startIndex - b.startIndex)
}

function precedingDecorators(declaration: Node): Node[] {
  const out: Node[] = []
  for (
    let sibling = declaration.previousNamedSibling;
    sibling !== null;
    sibling = sibling.previousNamedSibling
  ) {
    if (sibling.type === "comment") continue
    if (sibling.type !== "decorator") break
    out.push(sibling)
  }
  return out
}

function readDecorator(node: Node): Decorator | null {
  const written = firstNonCommentChild(node)
  if (written === null) return null
  const inner = throughParentheses(written)
  const line = node.startPosition.row + 1
  // `raw` quotes what was written, parentheses included, whatever `inner` reads through.
  const raw = written.text

  if (inner.type === "call_expression") {
    const callee = inner.childForFieldName("function")
    const target = callee === null ? null : throughParentheses(callee)
    const name = target === null ? UNNAMED_DECORATOR : leafIdentifier(target)
    const argsNode = inner.childForFieldName("arguments")
    const args = argsNode !== null ? readCallArguments(argsNode) : []
    return {
      name,
      ...qualifierOf(target),
      raw,
      arguments: args,
      boundary: false,
      line,
    }
  }

  // Bare `@Foo` or `@Ns.Foo` — no arguments.
  const name = leafIdentifier(inner)
  return {
    name,
    ...qualifierOf(inner),
    raw,
    arguments: [],
    boundary: false,
    line,
  }
}

function throughParentheses(node: Node): Node {
  if (node.type !== "parenthesized_expression" || hasErrorChild(node)) return node
  const enclosed = firstNonCommentChild(node)
  if (enclosed === null || hasErrorChild(enclosed)) return node
  return enclosed
}

function leafIdentifier(node: Node): string {
  if (node.type === "identifier" || node.type === "type_identifier") return node.text
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property")
    if (property !== null && property.text.length > 0) return property.text
  }
  return UNNAMED_DECORATOR
}

function qualifierOf(callee: Node | null): { qualifier?: string } {
  if (callee === null || callee.type !== "member_expression") return {}
  const object = callee.childForFieldName("object")
  if (object === null || object.text.length === 0) return {}
  return { qualifier: object.text }
}

function readCallArguments(argsNode: Node): string[] {
  const out: string[] = []
  for (const child of argsNode.namedChildren) {
    if (child === null) continue
    if (child.type === "comment") continue
    out.push(child.text)
  }
  return out
}
