import type { Decorator } from "@aburi/types"
import type { Node } from "web-tree-sitter"

/**
 * Read every decorator attached to a declaration node. Tree-sitter-typescript exposes
 * decorators as sibling children of the decorated declaration whose type is
 * `decorator`. The design contract requires:
 *   - `name`: the identifier the decorator invokes (e.g. `Post` in `@Post('/x')`).
 *   - `raw`: the original text after the `@` (e.g. `Post('/x')`).
 *   - `arguments`: each argument's raw text (empty when there is no call).
 *   - `boundary`: the framework plugin decides this later; extract initializes to false.
 *   - `line`: 1-based start line.
 */
export function readDecorators(declaration: Node): Decorator[] {
  const out: Decorator[] = []
  const parent = declaration.parent
  const scope = parent ?? declaration
  for (const child of scope.namedChildren) {
    if (child === null || child.type !== "decorator") continue
    const decorator = readDecorator(child)
    if (decorator !== null) out.push(decorator)
  }
  out.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
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
