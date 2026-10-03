import { CoreError } from "@aburi/core"
import type { Node } from "web-tree-sitter"

/**
 * Every identifier a destructuring pattern *binds*, in source order.
 *
 * Two readers: a destructuring declaration, each of whose bindings becomes a Symbol, and a
 * destructuring parameter, whose bindings are the names the call resolver must treat as
 * local to the function (`Signature.inputs[].bindings`, call-resolution.md §4.2).
 *
 * The distinction the walk has to keep is between a name being bound and a name being read.
 * `{ a: b }` binds `b` and names the property `a` on the value; `{ a = fallback }` binds `a`
 * and reads `fallback` from somewhere else entirely. Collecting every identifier under the
 * pattern would declare both of those, so each wrapper is entered through the one
 * field that holds a binding rather than through its children.
 *
 * Which makes the *set of wrappers* the thing that has to be right, and a missing one silent
 * — so an unmodelled node type is refused rather than passed over. An array hole (`[, x]`)
 * binds nothing and is not a named child, so it needs no case; a `comment` is a named child
 * and gets one.
 *
 * `unplaced` says what to do with an `ERROR` node, the text of a recovered parse the parser
 * could not place (`{ a, ? }`, `{ a b }`, `[...]`). A declaration refuses it like any other
 * node it does not model, which is the default. A parameter passes `"skip"`: the subtree binds
 * nothing, since a name the parser could not place is no binding, and the rest of the pattern
 * is still read. Refusing there would take the whole file out of the scan over one malformed
 * parameter list, which reading the parameter by its text alone never did. Only `ERROR` is
 * skipped; a node type the grammar does build and this walk does not model is still refused.
 */
export function collectPatternBindings(
  pattern: Node,
  unplaced: "refuse" | "skip" = "refuse",
): Node[] {
  const out: Node[] = []
  const visit = (node: Node): void => {
    if (node.type === "ERROR" && unplaced === "skip") return
    switch (node.type) {
      case "identifier":
      case "shorthand_property_identifier_pattern":
        out.push(node)
        return
      case "object_pattern":
      case "array_pattern":
        for (const child of node.namedChildren) {
          if (child !== null) visit(child)
        }
        return
      case "pair_pattern": {
        // The key is a `property_identifier`, a `string`, a `number` or a
        // `computed_property_name` depending on how it was written, and none of them is a
        // declaration. Reading the `value` field says so rather than filtering them out.
        const value = node.childForFieldName("value")
        if (value !== null) visit(value)
        return
      }
      // Two node types for one idea: the grammar uses `object_assignment_pattern` for an
      // object shorthand default (`{ a = 1 }`) and `assignment_pattern` for every other
      // default — an array element (`[a = 1]`) and a renamed property (`{ z: a = 1 }`).
      // Covering only the first bound nothing at all for the other two.
      case "assignment_pattern":
      case "object_assignment_pattern": {
        // `left` is the binding; `right` is a default expression evaluated elsewhere.
        const left = node.childForFieldName("left") ?? node.namedChild(0)
        if (left !== null) visit(left)
        return
      }
      case "rest_pattern": {
        const inner = node.namedChild(0)
        if (inner !== null) visit(inner)
        return
      }
      case "comment":
        // A named child of both pattern kinds, and the one thing inside a pattern that
        // legitimately binds nothing.
        return
      default:
        // Loud, because the alternative is the failure this whole change is about. A node
        // type this walk does not model binds nothing here, which is indistinguishable from
        // a pattern that declares nothing — and a binding lost that way leaves no Symbol (or,
        // in a parameter, no shadow), no diagnostic and no `skipped` entry. `assignment_pattern` went missing exactly this
        // way. Refusing sends the file to the per-file boundary instead, which names it.
        throw new CoreError(
          `Unmodelled node "${node.type}" inside a destructuring pattern at ${pattern.startPosition.row + 1}; refusing to report bindings this walk may have missed`,
          { code: "anonymous-symbol-id-attempted", value: node.type },
        )
    }
  }
  visit(pattern)
  return out
}
