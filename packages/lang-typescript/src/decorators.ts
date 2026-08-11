import type { Decorator } from "@aburi/types"
import type { Node } from "web-tree-sitter"

/**
 * Read every decorator attached to a specific declaration node.
 *
 * Tree-sitter-typescript puts the decorators in a different parent depending on where the
 * declaration sits: beside a method inside the class body, beside a bare declaration
 * inside the program, and — for `@A() export class C {}` — inside the `export_statement`
 * wrapper, where the grammar's rule is `decorator* 'export' declaration`. All three are
 * the same shape from the declaration's point of view: the decorators are the siblings
 * immediately before it. Only those siblings belong to it, which is why the run has to
 * stop rather than sweep the whole container.
 */
export function readDecorators(declaration: Node): Decorator[] {
  const found = collectDecoratorNodes(declaration)
  const decorators = found.map(readDecorator).filter((d): d is Decorator => d !== null)
  decorators.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return decorators
}

/**
 * Return the decorator nodes belonging to `declaration`, in source order.
 *
 * The walk goes backwards from the declaration rather than reading the parent's child list
 * and searching it for the declaration's own position. Both find the same run, but the
 * parent of a top-level declaration is the whole program and `namedChildren` unmarshals
 * every child into a JS object, so reading it once per declaration costs a file of N
 * declarations O(N²). The walk costs the length of the decorator run, which is nearly
 * always zero.
 *
 * `previousNamedSibling` steps over the anonymous `export` token, which is what lets one
 * walk cover the wrapped-export shape as well as the bare one.
 */
function collectDecoratorNodes(declaration: Node): Node[] {
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
