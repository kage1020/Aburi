import type { Decorator } from "@aburi/types"
import type { Node } from "web-tree-sitter"

/**
 * Read every decorator attached to a specific declaration node.
 *
 * Tree-sitter-typescript places decorators in two different positions depending on where
 * the declaration sits:
 *
 * 1. Methods and free-standing top-level declarations: decorators are named siblings of
 *    the declaration inside the shared parent (class body or program). Only siblings that
 *    sit directly before *this* declaration belong to it — walking every decorator in the
 *    container would attach every one to every member.
 *
 * 2. Exported declarations wrapped in an `export_statement`: the wrapper is the parent,
 *    and decorators are `decorator:` field children of the wrapper (they precede the
 *    inner declaration in source but the grammar hoists them onto the export node). Read
 *    every decorator child of the wrapper.
 *
 * The two branches produce the same Decorator[] shape; the caller does not care which one
 * fired.
 */
export function readDecorators(declaration: Node): Decorator[] {
  const found = collectDecoratorNodes(declaration)
  const decorators = found.map(readDecorator).filter((d): d is Decorator => d !== null)
  decorators.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return decorators
}

/**
 * Return the decorator nodes belonging to `declaration`, in source order. Handles the
 * "wrapped in export_statement" and the "sibling to member" cases separately.
 *
 * The sibling case walks backwards from the declaration rather than reading the parent's
 * child list and searching it for the declaration's own position. The two agree on the
 * answer, but the parent of a top-level declaration is the whole program, and
 * `namedChildren` unmarshals every child into a JS object — so reading it once per
 * declaration costs a file of N declarations O(N²), while the walk costs the length of
 * the decorator run, which is nearly always zero.
 */
function collectDecoratorNodes(declaration: Node): Node[] {
  const parent = declaration.parent
  if (parent !== null && parent.type === "export_statement") {
    // Wrapped export — decorators are field children of the wrapper itself.
    return parent.namedChildren.filter((c): c is Node => c !== null && c.type === "decorator")
  }
  const out: Node[] = []
  for (
    let sibling = declaration.previousNamedSibling;
    sibling !== null && sibling.type === "decorator";
    sibling = sibling.previousNamedSibling
  ) {
    out.push(sibling)
  }
  return out.reverse()
}

function readDecorator(node: Node): Decorator | null {
  // The decorator wraps either a call_expression (@Foo(...)) or a bare identifier / member
  // access (@Foo, @Ns.Foo). The first named child is the inner expression.
  const inner = node.namedChild(0)
  if (inner === null) return null
  const line = node.startPosition.row + 1

  if (inner.type === "call_expression") {
    const callee = inner.childForFieldName("function")
    const name = callee !== null ? leafIdentifier(callee) : ""
    const argsNode = inner.childForFieldName("arguments")
    const args = argsNode !== null ? readCallArguments(argsNode) : []
    return {
      name,
      raw: inner.text,
      arguments: args,
      boundary: false,
      line,
    }
  }

  // Bare `@Foo` or `@Ns.Foo` — no arguments.
  const name = leafIdentifier(inner)
  return {
    name,
    raw: inner.text,
    arguments: [],
    boundary: false,
    line,
  }
}

function leafIdentifier(node: Node): string {
  // `Ns.Foo` → `Foo`; `Foo` → `Foo`.
  if (node.type === "identifier" || node.type === "type_identifier") return node.text
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property")
    if (property !== null) return property.text
  }
  return node.text
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
