import type { Decorator } from "@aburi/types"
import type { Node } from "web-tree-sitter"

/**
 * Read every decorator attached to a specific declaration node.
 *
 * A decorator always belongs to the declaration it precedes. Tree-sitter-typescript parents
 * it in one of two places depending on whether anything else owns that declaration, and both
 * have to be read:
 *
 * - **Beside the declaration.** A class member (`class C { @A() m() {} }`) has its
 *   decorators as preceding siblings inside the class body; a declaration wrapped for export
 *   (`@A() export class C {}`) has them as preceding siblings inside the `export_statement`,
 *   whose rule is `decorator* 'export' ['default'] declaration`.
 *
 * - **Inside the declaration.** With no wrapper to hold it — `@A() class C {}`,
 *   `export @A() class C {}`, `export default @A() class C {}`, `@A() abstract class C {}` —
 *   the decorator is a `decorator:` field child of the declaration node itself.
 *
 * One declaration can have both at once: in `@A() export @B() class C {}`, `A` is the
 * wrapper's sibling and `B` is the class's child, and both decorate `C`. The two sources are
 * disjoint by construction, so the union needs no deduplication, and the line sort below puts
 * them back in source order.
 *
 * A **parameter** decorator (`m(@P() x)`) is deliberately out of reach of both: it is a child
 * of the parameter, and the method does not field-tag it.
 */
export function readDecorators(declaration: Node): Decorator[] {
  const found = collectDecoratorNodes(declaration)
  const decorators = found.map(readDecorator).filter((d): d is Decorator => d !== null)
  decorators.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return decorators
}

/** The decorator nodes belonging to `declaration`, from both placements, unordered. */
function collectDecoratorNodes(declaration: Node): Node[] {
  return [...precedingDecorators(declaration), ...declaration.childrenForFieldName("decorator")]
}

/**
 * The run of decorators written immediately before `declaration`, as siblings.
 *
 * The walk goes backwards from the declaration rather than reading the parent's child list
 * and searching it for the declaration's own position. Both find the same run, but the
 * parent of a top-level declaration is the whole program and `namedChildren` unmarshals
 * every child into a JS object, so reading it once per declaration costs a file of N
 * declarations O(N²) (lang-plugin.md §8.2). The walk pays for the run it collects plus
 * tree-sitter's own cost to step back one sibling, and stops as soon as the run ends — for
 * most declarations, before the first step returns anything.
 *
 * Anonymous tokens are stepped over for free, which is what lets one walk cover both the
 * class-member and the wrapped-export shape: `export` and `default` sit between the
 * decorators and the declaration in the wrapper, and `previousNamedSibling` does not see
 * them.
 *
 * A comment is a different matter. It is a *named* node, and tree-sitter puts it wherever
 * it was written — including between two decorators, or between the decorators and the
 * `export` keyword. Ending the run there would let a `// biome-ignore` or a TODO detach a
 * decorator from the class it decorates, which is silent: decorators feed
 * `mergeFrameworkClassification`, so the Symbol comes out with the wrong `extKind` rather
 * than with an error. Comments are skipped, the way `readCallArguments` skips them.
 */
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
