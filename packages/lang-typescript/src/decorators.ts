import type { Decorator } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { firstNonCommentChild } from "./ast-helpers"

/**
 * Read every decorator attached to a specific declaration node.
 *
 * A decorator always belongs to the declaration it precedes. Tree-sitter-typescript parents
 * it in one of two places, decided by **where it is written relative to the `export`
 * keyword**, and both have to be read:
 *
 * - **Beside the declaration**, when nothing separates the two. A class member
 *   (`class C { @A() m() {} }`) has its decorators as preceding siblings inside the class
 *   body, and a decorator written *before* `export` has them as preceding siblings inside the
 *   `export_statement`, whose rule is `decorator* 'export' ['default'] declaration`.
 *
 * - **Inside the declaration**, when the wrapper's rule cannot hold it. A decorator written
 *   *after* the keyword (`export @A() class C {}`, `export default @A() class C {}`) has
 *   nowhere in the wrapper to go, and one on a declaration that is not exported at all
 *   (`@A() class C {}`, `@A() abstract class C {}`) has no wrapper. Both become a
 *   `decorator:` field child of the declaration node itself.
 *
 * The two sources cannot overlap: a node has one parent, so a preceding sibling of the
 * declaration is never also its child. That is why the union needs no deduplication.
 *
 * Both positions at once — `@A() export @B() class C {}` — is what TypeScript rejects as
 * TS8038, but the grammar accepts it, so it does reach here from a half-edited file. Reading
 * the union rather than one side means such a file loses no decorator on the way to being
 * reported.
 *
 * A **parameter** decorator (`m(@P() x)`) is deliberately out of reach of both: it is a child
 * of the parameter, and the method does not field-tag it.
 */
export function readDecorators(declaration: Node): Decorator[] {
  return collectDecoratorNodes(declaration)
    .map(readDecorator)
    .filter((d): d is Decorator => d !== null)
}

/**
 * The decorator nodes belonging to `declaration`, in source order.
 *
 * Ordered on `startIndex` rather than on the line each one starts, because two decorators
 * can share a line and `Decorator` carries no column: `@UseGuards(G) @Controller("x")` would
 * otherwise fall back on whatever tiebreak the caller chose, and the order is a contract —
 * `framework-nestjs` resolves a class with several recognised decorators by taking the first
 * in source order. A byte offset is total and agrees with the line ordering that integrity
 * invariant #11 checks, so one sort satisfies both.
 */
function collectDecoratorNodes(declaration: Node): Node[] {
  const found = [
    ...precedingDecorators(declaration),
    ...declaration.childrenForFieldName("decorator"),
  ]
  return found.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * The run of decorators written immediately before `declaration`, as siblings, nearest one
 * first — the walk's own order, which the caller sorts.
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
  // access (@Foo, @Ns.Foo). A comment may be written between the `@` and the expression —
  // `@/* why */ Foo()` parses — and `leafIdentifier` falls back to a node's text, so taking
  // the first named child unconditionally would name the decorator after the comment.
  const inner = firstNonCommentChild(node)
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
