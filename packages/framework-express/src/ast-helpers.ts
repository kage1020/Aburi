import type { SyntaxNode } from "@aburi/core"

/**
 * A literal string, read as `@aburi/lang-typescript` reads the path it names a registration
 * by: quoted, or a backtick with no substitution, which is the same value (`readStaticString`
 * there), and through the wrappers a value is read through (`unwrapValue` there).
 *
 * The two readers have to agree, because one Symbol carries both answers. When this accepted
 * only `"…"`, `` app.use(`/api`, usersRouter) `` was named `app__use__$api__d0` with
 * `path-literal:/api` and classified `middleware` rather than `mount`: a registration mounted
 * at a path by its id and at none by its kind. This package depends on `@aburi/core`'s
 * `SyntaxNode` alone, so the check is restated here rather than imported.
 */
export function isPathLiteral(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  if (value.type === "string") return true
  if (value.type !== "template_string") return false
  return value.namedChildren.every((child) => child?.type !== "template_substitution")
}

/**
 * `lang-typescript`'s `unwrapValue` set: each wraps one expression, written first. The old-style
 * assertion `<T>x` is not on it there, so it is not on it here: its first named child is the
 * type, and reading it on one side only would make a registration's kind and its name disagree,
 * as `isPathLiteral` describes.
 */
const VALUE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
])

/** `node` with those wrappers stepped through; an empty wrapper answers with itself. */
export function unwrapValue(node: SyntaxNode): SyntaxNode {
  let cursor = node
  while (VALUE_WRAPPER_TYPES.has(cursor.type)) {
    const inner = cursor.namedChildren.find((child) => child !== null && child.type !== "comment")
    if (inner === undefined || inner === null) return cursor
    cursor = inner
  }
  return cursor
}

/**
 * `node`'s named children less comments, which the grammar hangs wherever they were written.
 * Counted as arguments, a comment written in front of the path made `app.use("/api", router)` a
 * three-argument call and no mount.
 */
export function writtenChildren(node: SyntaxNode | null): SyntaxNode[] {
  if (node === null) return []
  return node.namedChildren.filter(
    (child): child is SyntaxNode => child !== null && child.type !== "comment",
  )
}
