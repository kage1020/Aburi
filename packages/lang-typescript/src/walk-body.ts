import type {
  BodyExtraction,
  CallCandidate,
  Rule,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { bodyNodesOf, findChild } from "./ast-helpers"
import { functionValuedField, isConstructorMember, memberHasOwnSymbol } from "./class-members"

/**
 * Walk a Symbol's body and produce control-flow rules + call candidates.
 *
 * Rule extraction follows the design contract:
 *   - `guard`: an `if` statement whose body contains an early exit (`throw`, `return`,
 *     `continue`, `break`, `process.exit`).
 *   - `throw`: a bare `throw new X(...)` reachable from the body.
 *   - `return`: only non-trivial return values (literals / identifiers / member chains /
 *     unary + trivial / call-only returns are all dropped per drop-list §5.3-§5.5).
 *   - `loop`: `for` / `for...in` / `for...of` / `while` / `do...while`.
 *   - `try`: try / catch / finally — the catch body's contents do NOT feed the same
 *     Symbol's rules.
 *   - `switch`: switch statement.
 *
 * Calls are every call_expression whose callee we can normalize. `await` and `new`
 * modifiers surface as flags; each argument's literal value (if any) is captured on
 * `literalArgs` for effect plugins that pattern-match on constants (SQL strings, HTTP
 * paths, event names, …).
 */
export function walkBody(symbol: SymbolCandidate<Node>, _ctx: WalkContext<Node>): BodyExtraction {
  const rules: Rule[] = []
  const calls: CallCandidate[] = []
  // Every body the Symbol was declared with, not just the leading declaration's.
  for (const body of bodyNodesOf(symbol)) {
    // The class is read off the body, not off the Symbol: `fullNode` is the **leading**
    // declaration, and a fold can put a class body on a Symbol another declaration heads.
    const owner = body.type === "class_body" ? body.parent : null
    if (owner !== null) visitOwnClassBody(owner, body, rules, calls)
    else visit(body, rules, calls)
  }
  rules.sort((a, b) => a.line - b.line)
  calls.sort((a, b) => a.line - b.line)
  return { rules, calls }
}

/**
 * A class Symbol's own body: what **defining and constructing** the class runs, per
 * `lang-plugin.md` LP20a–LP20f. Field initialisers, static blocks and the constructor stay; a
 * member whose body another Symbol records does not.
 *
 * Only the *body* is skipped, never the member. A member's `bodyNode` is whatever its `body`
 * field holds — a `statement_block` for a method, the expression itself for an
 * expression-bodied arrow — so a parameter default (`m(x = f())`) is outside it either way and
 * would be lost with nothing to say so. That is LP20d, and the reason this reaches for the
 * `body` field rather than for the member. A field holding a function is skipped the same way
 * and for the same reason: constructing the class creates the closure, and only entering it
 * runs the body (LP20f).
 *
 * And only for the Symbol's own bodies: a class written inside a function or a method is not
 * extracted, so every call in it belongs to the Symbol whose body encloses it (LP20e).
 */
function visitOwnClassBody(
  classNode: Node,
  body: Node,
  rules: Rule[],
  calls: CallCandidate[],
): void {
  for (const member of body.namedChildren) {
    if (member === null) continue
    const memberBody = memberBodySkippedHere(classNode, member)
    if (memberBody === null) visit(member, rules, calls)
    else visitExcluding(member, memberBody, rules, calls)
  }
}

/**
 * Everything under `node` except the subtree at `skipped`.
 *
 * A method's body is a direct child of the member. A field's is a child of the function the
 * field holds, one level further down — so the walk follows the path to it rather than
 * filtering direct children, which covers both depths with one rule and keeps whatever
 * surrounds the body on the class: a parameter default (LP20d), a field's decorator, its type
 * annotation.
 *
 * Descending an ancestor instead of visiting it reports nothing for the ancestor itself, which
 * is what is wanted: the only nodes on the path are the member and the function it holds, and
 * `visit` has no arm for either.
 */
function visitExcluding(node: Node, skipped: Node, rules: Rule[], calls: CallCandidate[]): void {
  for (const part of node.namedChildren) {
    // By `id`, not by reference: a field read and a children read of the same node hand back
    // different JS wrappers, so `===` never matches. `Node.equals()` answers the same question
    // and would do; `id` is a field read rather than a call across the WASM boundary
    // (`lang-plugin.md` §8.2). Not by type: a `method_definition` has exactly one
    // `statement_block` today, but a member shape carrying a second would start dropping it
    // without a word.
    if (part === null || part.id === skipped.id) continue
    if (isAncestorOf(part, skipped)) visitExcluding(part, skipped, rules, calls)
    else visit(part, rules, calls)
  }
}

function isAncestorOf(node: Node, descendant: Node): boolean {
  for (let parent = descendant.parent; parent !== null; parent = parent.parent) {
    if (parent.id === node.id) return true
  }
  return false
}

/** The member's body when this class does not walk it, or null when the class still owns it. */
function memberBodySkippedHere(classNode: Node, member: Node): Node | null {
  if (!memberHasOwnSymbol(classNode, member)) return null
  // The constructor's body is recorded on `#C.constructor` too, and stays here anyway: `new
  // C()` runs it and resolves to this Symbol (LP20b).
  if (isConstructorMember(member)) return null
  // A field's body belongs to the function it holds; a method's, to the method itself.
  return (functionValuedField(member) ?? member).childForFieldName("body")
}

function visit(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  switch (node.type) {
    case "if_statement":
      handleIfStatement(node, rules, calls)
      return
    case "throw_statement":
      rules.push(makeRule("throw", node, { what: extractThrowWhat(node) }))
      visitCallsInside(node, calls)
      return
    case "return_statement":
      handleReturnStatement(node, rules, calls)
      return
    case "for_statement":
    case "for_in_statement":
      rules.push(makeRule("loop", node, { loopKind: "for" }))
      visitChildren(node, rules, calls)
      return
    case "while_statement":
      rules.push(makeRule("loop", node, { loopKind: "while" }))
      visitChildren(node, rules, calls)
      return
    case "do_statement":
      rules.push(makeRule("loop", node, { loopKind: "do" }))
      visitChildren(node, rules, calls)
      return
    case "try_statement":
      rules.push(makeRule("try", node))
      // Only the try block's statements contribute rules/calls; catch/finally are skipped
      // per ir-schema §8.1 so a rewritten error handler does not perturb the logic axis.
      handleTryStatement(node, rules, calls)
      return
    case "switch_statement":
      rules.push(makeRule("switch", node, { condition: extractSwitchCondition(node) }))
      visitChildren(node, rules, calls)
      return
    case "call_expression":
    case "new_expression":
      handleCall(node, calls)
      visitChildren(node, rules, calls)
      return
    default:
      visitChildren(node, rules, calls)
      return
  }
}

function visitChildren(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  for (const child of node.namedChildren) {
    if (child === null) continue
    visit(child, rules, calls)
  }
}

function visitCallsInside(node: Node, calls: CallCandidate[]): void {
  for (const child of node.namedChildren) {
    if (child === null) continue
    if (child.type === "call_expression" || child.type === "new_expression") {
      handleCall(child, calls)
    }
    visitCallsInside(child, calls)
  }
}

function handleIfStatement(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const consequence = node.childForFieldName("consequence")
  if (consequence !== null && containsEarlyExit(consequence)) {
    const condition = node.childForFieldName("condition")
    rules.push(
      makeRule("guard", node, {
        condition: condition !== null ? stripParens(condition.text) : null,
      }),
    )
  }
  // Even when the `if` is a plain branch, its consequence still contributes to the same
  // Symbol's logic (nested guards / calls / loops).
  visitChildren(node, rules, calls)
}

function handleReturnStatement(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const value = node.namedChildren[0] ?? null
  if (value === null) return
  if (value.type === "call_expression" || value.type === "new_expression") {
    // Call-only return: no rule, but the call still goes into calls[] so effect plugins
    // can inspect it. Descend into the callee and arguments so nested calls like the
    // `bar()` in `return foo(bar())` are recorded too — otherwise the outer call would
    // shadow every inner one.
    handleCall(value, calls)
    visitChildren(value, rules, calls)
    return
  }
  if (isTrivialExpr(value)) return
  rules.push(makeRule("return", node, { expr: normalizeExpression(value.text) }))
  visitChildren(value, rules, calls)
}

function handleTryStatement(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const body = node.childForFieldName("body")
  if (body !== null) visit(body, rules, calls)
}

function handleCall(node: Node, calls: CallCandidate[]): void {
  const isNew = node.type === "new_expression"
  const callee = node.childForFieldName(isNew ? "constructor" : "function") ?? node.namedChild(0)
  if (callee === null) return
  const shape = describeCallee(callee)
  if (shape === null) return
  const argsNode = node.childForFieldName("arguments") ?? findChild(node, "arguments") ?? null
  const argChildren = argsNode !== null ? argsNode.namedChildren : []
  const literalArgs: (string | null)[] = argChildren.map((arg) =>
    arg === null ? null : extractLiteral(arg),
  )
  const inAwait = isUnderAwait(node)
  const line = node.startPosition.row + 1
  calls.push({
    target: shape.target,
    line,
    argumentCount: argChildren.length,
    inAwait,
    inNew: isNew,
    literalArgs,
    // Only set when positively true so the field stays absent on the
    // overwhelming majority of calls and existing IR bytes do not move.
    ...(shape.dynamic ? { dynamicReceiver: true } : {}),
  })
}

/**
 * Trivial expression detector matching drop-list §5.5 exactly. Anything that reads like a
 * simple identifier / literal / member chain / unary wrap should NOT surface as a return
 * rule. Everything else does.
 */
function isTrivialExpr(node: Node): boolean {
  switch (node.type) {
    case "number":
    case "string":
    case "true":
    case "false":
    case "null":
    case "undefined":
      return true
    case "identifier":
    case "this":
    case "super":
      return true
    case "member_expression":
    case "subscript_expression": {
      const object = node.childForFieldName("object")
      return object !== null && isTrivialExpr(object)
    }
    case "unary_expression":
    case "update_expression": {
      const argument = node.childForFieldName("argument") ?? node.namedChild(0)
      return argument !== null && isTrivialExpr(argument)
    }
    case "parenthesized_expression": {
      const inner = node.namedChild(0)
      return inner !== null && isTrivialExpr(inner)
    }
    default:
      return false
  }
}

function containsEarlyExit(node: Node): boolean {
  const stack: Node[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    switch (current.type) {
      case "return_statement":
      case "throw_statement":
      case "continue_statement":
      case "break_statement":
        return true
      case "call_expression": {
        const callee = current.childForFieldName("function")
        if (callee !== null && normalizeCallee(callee) === "process.exit") return true
        break
      }
    }
    for (const child of current.namedChildren) {
      if (child !== null) stack.push(child)
    }
  }
  return false
}

/**
 * What `describeCallee` learned about one callee expression.
 *
 * `target` is the normalized string that lands in `CallCandidate.target` and
 * eventually in `Symbol.calls[].target` — its computation is unchanged, so IR
 * bytes and fingerprints are untouched by the two flags beside it.
 */
interface CalleeShape {
  target: string
  /**
   * The receiver was positively identified as an expression rather than a name
   * (`getRepo().save()`, `items[0].save()`, `(a ?? b).save()`). Such a call can
   * never resolve in the untyped tier, and `call-resolution.md` §8.1 wants it
   * reported as `dynamic` rather than lumped in with genuine typos.
   */
  dynamic: boolean
  /**
   * The node was not a shape this normalizer models, so its source text was
   * taken verbatim (`svc!`, `x as Foo`). Opaque is deliberately NOT treated as
   * dynamic on its own: a non-null assertion still names a binding. It only
   * becomes evidence of an expression receiver when it sits inside explicit
   * parentheses, which is how expression receivers have to be written.
   */
  opaque: boolean
}

function describeCallee(node: Node): CalleeShape | null {
  switch (node.type) {
    case "identifier":
    case "property_identifier":
      return { target: node.text, dynamic: false, opaque: false }
    case "this":
      return { target: "this", dynamic: false, opaque: false }
    case "super":
      return { target: "super", dynamic: false, opaque: false }
    case "member_expression": {
      const object = node.childForFieldName("object")
      const property = node.childForFieldName("property")
      const objectShape = object !== null ? describeCallee(object) : null
      const propertyStr = property !== null ? property.text : null
      if (objectShape === null || propertyStr === null) return null
      return {
        target: `${objectShape.target}.${propertyStr}`,
        dynamic: objectShape.dynamic,
        opaque: objectShape.opaque,
      }
    }
    case "subscript_expression": {
      const object = node.childForFieldName("object")
      if (object === null) return null
      const inner = describeCallee(object)
      if (inner === null) return null
      return { target: inner.target, dynamic: true, opaque: false }
    }
    case "parenthesized_expression": {
      const innerNode = node.namedChild(0)
      if (innerNode === null) return null
      const inner = describeCallee(innerNode)
      if (inner === null) return null
      return { target: inner.target, dynamic: inner.dynamic || inner.opaque, opaque: false }
    }
    case "call_expression": {
      const innerNode = node.childForFieldName("function")
      if (innerNode === null) return null
      const inner = describeCallee(innerNode)
      if (inner === null) return null
      return { target: inner.target, dynamic: true, opaque: false }
    }
    default:
      return node.text.length > 0 ? { target: node.text, dynamic: false, opaque: true } : null
  }
}

function normalizeCallee(node: Node): string | null {
  return describeCallee(node)?.target ?? null
}

function extractLiteral(node: Node): string | null {
  switch (node.type) {
    case "number":
    case "true":
    case "false":
    case "null":
    case "undefined":
      return node.text
    case "string": {
      const parts: string[] = []
      for (const child of node.namedChildren) {
        if (child === null) continue
        if (child.type === "string_fragment") parts.push(child.text)
      }
      if (parts.length > 0) return parts.join("")
      const raw = node.text
      return raw.length >= 2 ? raw.slice(1, -1) : raw
    }
    default:
      return null
  }
}

function isUnderAwait(node: Node): boolean {
  const parent = node.parent
  if (parent === null) return false
  if (parent.type === "await_expression") return true
  return false
}

function extractThrowWhat(node: Node): string | null {
  const arg = node.namedChild(0)
  if (arg === null) return null
  if (arg.type === "new_expression") {
    const ctor = arg.childForFieldName("constructor")
    if (ctor !== null) return ctor.text
  }
  return arg.text
}

function extractSwitchCondition(node: Node): string | null {
  const cond = node.childForFieldName("value") ?? node.childForFieldName("condition")
  return cond !== null ? stripParens(cond.text) : null
}

function stripParens(text: string): string {
  return text.replace(/^\s*\(([\s\S]*)\)\s*$/, "$1").trim()
}

function normalizeExpression(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function makeRule(
  type: Rule["type"],
  node: Node,
  overrides: Partial<Pick<Rule, "condition" | "what" | "expr" | "loopKind">> = {},
): Rule {
  return {
    type,
    line: node.startPosition.row + 1,
    condition: overrides.condition ?? null,
    what: overrides.what ?? null,
    expr: overrides.expr ?? null,
    loopKind: overrides.loopKind ?? null,
  }
}
