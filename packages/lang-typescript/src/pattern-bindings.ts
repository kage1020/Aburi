import type { Node } from "web-tree-sitter"

/**
 * What `collectPatternBindings` does with a node it does not model. A destructuring declaration
 * passes the refusal that withdraws its file, and a destructuring parameter passes `"skip"`.
 */
export type Unmodelled = "skip" | ((node: Node) => never)

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
 * Which makes the *set of wrappers* the thing that has to be right, and a missing one silent.
 * An array hole (`[, x]`) binds nothing and is not a named child, so it needs no case; a
 * `comment` is a named child and gets one.
 *
 * `unmodelled` says what to do with every other node, and the two readers answer differently
 * because a missed binding costs them different things. A declaration's binding lost without
 * a word is a Symbol missing from the IR with no diagnostic and no `skipped` entry, which is
 * how `assignment_pattern` once went missing, so a declaration refuses and its file goes to
 * the per-file boundary, which names it. A parameter's binding missed costs a shadow, never a
 * Symbol, while a refusal there would take the whole file out of the scan over one malformed
 * parameter list, which reading the parameter by its text alone never did. So a parameter
 * skips the node, which binds nothing, and the rest of the pattern is still read. That covers
 * the text of a recovered parse the parser could not place (an ERROR node: `{ a, ? }`,
 * `{ a b }`, `[...]`) and an expression the grammar places where a binding belongs, which no
 * compiler accepts in a parameter (`{ a: obj.b }`, `[a[0]]`, `{ a: b!, c }`,
 * `{ a: undefined }`). The two readers share this walk, so a pattern node type the grammar
 * gains is refused by the first declaration that writes one, not skipped unseen.
 *
 * A parameter also reads one repair the parser makes to a malformed pattern
 * (`isRepairedPattern`), and reads the expression it gets through `EXPRESSION_SPELLING`.
 */
export function collectPatternBindings(pattern: Node, unmodelled: Unmodelled): Node[] {
  const out: Node[] = []
  const visit = (node: Node, repaired: boolean): void => {
    const type = repaired ? (EXPRESSION_SPELLING.get(node.type) ?? node.type) : node.type
    switch (type) {
      case "identifier":
      case "shorthand_property_identifier_pattern":
        out.push(node)
        return
      case "object_pattern":
      case "array_pattern":
        for (const child of node.namedChildren) {
          if (child !== null) visit(child, repaired)
        }
        return
      case "pair_pattern": {
        // The key is a `property_identifier`, a `string`, a `number` or a
        // `computed_property_name` depending on how it was written, and none of them is a
        // declaration. Reading the `value` field says so rather than filtering them out.
        const value = node.childForFieldName("value")
        if (value !== null) visit(value, repaired)
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
        if (left !== null) visit(left, repaired)
        return
      }
      case "rest_pattern": {
        const inner = node.namedChild(0)
        if (inner !== null) visit(inner, repaired)
        return
      }
      case "comment":
        // A named child of both pattern kinds, and the one thing inside a pattern that
        // legitimately binds nothing.
        return
      default:
        // A node this walk does not model: a declaration refuses it, and a parameter skips it
        // unless it is the one repair the walk reads through.
        if (unmodelled !== "skip") unmodelled(node)
        if (isRepairedPattern(node)) {
          const operand = node.namedChild(0)
          if (operand !== null) visit(operand, true)
        }
    }
  }
  visit(pattern, false)
  return out
}

/**
 * Whether `node` is a destructuring pattern the parser could keep only as an expression.
 *
 * The parser does not always keep a malformed array pattern as an `array_pattern` around an
 * ERROR node. For `[a, ?, b]` or `[a, b c]` in a parameter, and for an object pattern holding
 * one (`{ q, k: [a, ?] }`), it reads an array (or object) expression and inserts a zero-width
 * `!` after it, since a non-null expression is something the grammar lets a parameter hold. The
 * parameter then arrives as `non_null_expression > array`, the `!` MISSING. The names inside
 * were still written in binding position, so a parameter reads them. A `!` the source wrote
 * (`[a]!`) is no repair: it binds nothing, like any other expression in a pattern.
 */
export function isRepairedPattern(node: Node): boolean {
  if (node.type !== "non_null_expression") return false
  const bang = node.lastChild
  if (bang === null || bang.type !== "!" || !bang.isMissing) return false
  const operand = node.namedChild(0)
  return operand !== null && (operand.type === "array" || operand.type === "object")
}

/**
 * The pattern node each expression node stands for under a repaired pattern
 * (`isRepairedPattern`). The parser read the text as an expression, so `[a = 1, ?]` arrives as
 * an `array` holding an `assignment_expression`, and `{ q, k: [x, ?] }` as an `object` holding
 * a `shorthand_property_identifier` and a `pair`. Each is read through the same field as the
 * pattern node it spells. These are the types measured under the repair; nowhere else is one of
 * them read as a pattern.
 */
const EXPRESSION_SPELLING: ReadonlyMap<string, string> = new Map([
  ["array", "array_pattern"],
  ["object", "object_pattern"],
  ["pair", "pair_pattern"],
  ["shorthand_property_identifier", "shorthand_property_identifier_pattern"],
  ["assignment_expression", "assignment_pattern"],
  ["spread_element", "rest_pattern"],
])
