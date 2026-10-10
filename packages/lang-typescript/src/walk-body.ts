import { isQnameSegment, normalizeRuleText } from "@aburi/core"
import {
  type BodyExtraction,
  type CallCandidate,
  COMPUTED_TARGET_SEGMENT,
  type Rule,
  type SymbolCandidate,
  type WalkContext,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import {
  bodyNodesOf,
  findChild,
  firstNonCommentChild,
  hasErrorChild,
  thrownValue,
  walkDescendants,
} from "./ast-helpers"
import { functionValuedField, isConstructorMember, memberSymbolSegment } from "./class-members"
import { objectEntryOf } from "./object-members"
import { decodeStringLiteral, readStaticString } from "./string-escape"

/**
 * Walk a Symbol's body and produce control-flow rules + call candidates.
 *
 * Which statements become rules, and which returns are too trivial to, is the drop-list
 * contract (`drop-list.md`); `visitNode` is the switch that applies it. A `try` statement's
 * `try` block and `finally` block feed the Symbol like any other block. Its `catch` clause feeds
 * the Symbol's calls and none of its rules (`ir-schema.md` §8.2, `handleTryStatement`).
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
    const owner = body.type === "class_body" ? body.parent : null
    if (owner !== null) {
      visitOwnClassBody(owner, body, rules, calls)
      continue
    }
    if (body.type === "object") {
      visitOwnObjectBody(body, rules, calls)
      continue
    }
    const parameters = body.parent?.childForFieldName("parameters") ?? null
    if (parameters !== null) visitParameterDefaults(parameters, rules, calls)
    if (isConciseBody(body)) visitConciseBody(body, rules, calls)
    else visitNode(body, rules, calls)
  }
  rules.sort((a, b) => a.line - b.line)
  calls.sort((a, b) => a.line - b.line)
  return { rules, calls }
}

function visitParameterDefaults(parameters: Node, rules: Rule[], calls: CallCandidate[]): void {
  for (const parameter of parameters.namedChildren) {
    if (parameter === null) continue
    for (const part of parameter.namedChildren) {
      if (part !== null && part.type !== "decorator") visitNode(part, rules, calls)
    }
  }
}

/**
 * A class Symbol's own body: what **defining and constructing** the class runs, per
 * `lang-plugin.md` LP20a–LP20f. Field initialisers, static blocks and the constructor stay; a
 * member whose body another Symbol records does not — and which members those are is
 * `memberSymbolSegment`'s one answer, shared with extraction.
 *
 * Only what the member's Symbol walks is skipped, never the member: its body and its parameter
 * list (LP20d). The member's decorators stay, and the parameter decorators the skipped list
 * carries are walked back in afterwards (`visitParameterDecorators`), because a decorator's
 * arguments run when the class is defined, not when the member is called. A field holding a
 * function is skipped the same way and for the same reason: constructing the class creates the
 * closure, and only entering it runs the body (LP20f).
 *
 * An overload signature declares its member too, but has no body, so nothing of it is skipped
 * and the class reads it whole, as it did before overloads folded into their implementation's
 * Symbol (LP8q). The member's walk starts from bodies, and an overload's parameter list sits
 * beside none. So what that list holds stays here: a parameter decorator's arguments, which is
 * where an implementation's go too, and a default, which `tsc` rejects in an overload (TS2371)
 * and which never runs.
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
    if (memberBody === null) {
      visitNode(member, rules, calls)
      continue
    }
    const parameters = memberBody.parent?.childForFieldName("parameters") ?? null
    if (parameters === null) {
      visitExcluding(member, [memberBody], rules, calls)
      continue
    }
    visitExcluding(member, [memberBody, parameters], rules, calls)
    visitParameterDecorators(parameters, rules, calls)
  }
}

function visitOwnObjectBody(object: Node, rules: Rule[], calls: CallCandidate[]): void {
  for (const entry of object.namedChildren) {
    if (entry === null) continue
    const read = objectEntryOf(entry)
    if (read === null) {
      visitNode(entry, rules, calls)
      continue
    }
    if (read.object !== null) {
      visitExcluding(entry, [read.object], rules, calls)
      visitOwnObjectBody(read.object, rules, calls)
      continue
    }
    const skipped = [
      read.fn.childForFieldName("body"),
      read.fn.childForFieldName("parameters"),
    ].filter((node): node is Node => node !== null)
    visitExcluding(entry, skipped, rules, calls)
  }
}

function visitExcluding(
  node: Node,
  skipped: readonly Node[],
  rules: Rule[],
  calls: CallCandidate[],
): void {
  for (const part of node.namedChildren) {
    if (part === null || skipped.some((s) => s.id === part.id)) continue
    if (skipped.some((s) => isAncestorOf(part, s))) visitExcluding(part, skipped, rules, calls)
    else visitNode(part, rules, calls)
  }
}

/** The decorators on a parameter list's parameters, which the function's own walk leaves out. */
function visitParameterDecorators(parameters: Node, rules: Rule[], calls: CallCandidate[]): void {
  for (const parameter of parameters.namedChildren) {
    if (parameter === null) continue
    for (const part of parameter.namedChildren) {
      if (part !== null && part.type === "decorator") visitNode(part, rules, calls)
    }
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
  if (memberSymbolSegment(classNode, member) === null) return null
  if (isConstructorMember(member)) return null
  // A field's body belongs to the function it holds; a method's, to the method itself.
  return (functionValuedField(member) ?? member).childForFieldName("body")
}

/**
 * Every loop kind the grammar has, with the `loopKind` its `loop` rule carries. `visitNode` reads
 * it for that rule and `scopeInside` for where a `break` or `continue` ends, so a kind missing
 * here loses both at once: no `loop` rule, and a `continue` inside it read as leaving the `if`
 * around it. `for_in_statement` is `for…in`, `for…of` and `for await…of` alike.
 */
const LOOP_KINDS: ReadonlyMap<string, NonNullable<Rule["loopKind"]>> = new Map([
  ["for_statement", "for"],
  ["for_in_statement", "for"],
  ["while_statement", "while"],
  ["do_statement", "do"],
])

function visitNode(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const loopKind = LOOP_KINDS.get(node.type)
  if (loopKind !== undefined) {
    rules.push(makeRule("loop", node, { loopKind }))
    visitChildren(node, rules, calls)
    return
  }
  switch (node.type) {
    case "if_statement":
      handleIfStatement(node, rules, calls)
      return
    case "throw_statement":
      rules.push(makeRule("throw", node, { what: nullableRuleText(thrownValue(node)?.node) }))
      visitCallsInside(node, calls)
      return
    case "return_statement":
      handleReturnStatement(node, rules, calls)
      return
    case "try_statement":
      rules.push(makeRule("try", node))
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
    visitNode(child, rules, calls)
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
        condition: condition !== null ? conditionText(condition) : null,
      }),
    )
  }
  visitChildren(node, rules, calls)
}

function handleReturnStatement(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const value = node.namedChildren[0] ?? null
  if (value === null) return
  if (isCallOnly(value)) {
    handleCall(value, calls)
    visitChildren(value, rules, calls)
    return
  }
  // A trivial return is not walked. That loses nothing only because a trivial expression holds
  // no call: `isTrivialExpr` checks every operand that could hold one, and a case added there
  // that leaves such an operand unchecked takes the calls in it out of every Symbol.
  if (isTrivialExpr(value)) return
  rules.push(makeRule("return", node, { expr: ruleText(value) }))
  visitChildren(value, rules, calls)
}

function visitConciseBody(body: Node, rules: Rule[], calls: CallCandidate[]): void {
  const value = unparenthesized(body)
  if (!isCallOnly(value) && !isTrivialExpr(value)) {
    rules.push(makeRule("return", body, { expr: ruleText(value) }))
  }
  visitNode(body, rules, calls)
}

function isConciseBody(body: Node): boolean {
  return body.parent?.type === "arrow_function" && body.type !== "statement_block"
}

function unparenthesized(node: Node): Node {
  if (node.type !== "parenthesized_expression") return node
  const [only, ...rest] = node.namedChildren.filter(
    (child): child is Node => child !== null && child.type !== "comment",
  )
  return only !== undefined && rest.length === 0 ? only : node
}

/** A returned value that is one call: recorded in `calls[]`, never a rule (`drop-list.md` §5.4). */
function isCallOnly(value: Node): boolean {
  return value.type === "call_expression" || value.type === "new_expression"
}

/**
 * The try block and the `finally` block are walked as any block is: `finally` runs on every path,
 * so what it does is what the Symbol does. The catch clause gives its **calls** and withholds its
 * rules (ir-schema.md §8.2), so an error handler's own control flow leaves `logic` alone, while a
 * call it makes moves `logic` exactly as it would anywhere else once an effect plugin classifies
 * it. Neither block was visited before, so a database write added in either one reached no
 * Symbol's `calls[]` or `effects[]` and the diff filed the edit as a syntax-only change.
 *
 * The clause goes through `visitNode`, as a try block does, so it records exactly the calls the
 * same statements would record there, with the drop list applied the same way. The rules that
 * walk produces — a guard, a `throw`, a loop, a `return`, a nested `try` and whatever that
 * `try`'s own `finally` holds — go into `withheld`, which nothing reads. `visitCallsInside`, which
 * the `throw` arm uses, collects every call under a node whatever the drop list says. Over a
 * catch clause it would record the same calls today, but only because a trivial return holds no
 * call (`handleReturnStatement`); walking the clause as a block keeps the two sides agreeing
 * without leaning on that.
 */
function handleTryStatement(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const body = node.childForFieldName("body")
  if (body !== null) visitNode(body, rules, calls)
  const handler = node.childForFieldName("handler")
  const withheld: Rule[] = []
  if (handler !== null) visitNode(handler, withheld, calls)
  const finalizer = node.childForFieldName("finalizer")
  if (finalizer !== null) visitNode(finalizer, rules, calls)
}

function handleCall(node: Node, calls: CallCandidate[]): void {
  const isNew = node.type === "new_expression"
  const callee = node.childForFieldName(isNew ? "constructor" : "function") ?? node.namedChild(0)
  if (callee === null) return
  const shape = describeCallee(callee)
  if (shape === null) return
  const argsNode = node.childForFieldName("arguments") ?? findChild(node, "arguments") ?? null
  const argChildren = (argsNode !== null ? argsNode.namedChildren : []).filter(
    (arg) => arg !== null && arg.type !== "comment",
  )
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
    ...(shape.dynamic ? { dynamicReceiver: true } : {}),
  })
}

/**
 * Whether a returned expression is too trivial to be a `return` rule (`drop-list.md` §5.5): a
 * literal, an identifier, `this` or `super`, a member chain on a trivial object, a bracket access
 * whose object and index are both trivial, and a unary operator, an update operator or a
 * parenthesis around a trivial expression. Anything else is a rule unless it is call-only, which
 * each caller tests first (§5.4).
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
    case "member_expression": {
      const object = node.childForFieldName("object")
      return object !== null && isTrivialExpr(object)
    }
    case "subscript_expression": {
      // A property is a name; an index is an expression, so it is the one place a call can hide in
      // an otherwise-trivial read — and a trivial return is never walked, so it would be lost.
      const object = node.childForFieldName("object")
      const index = node.childForFieldName("index")
      if (object === null || index === null) return false
      return isTrivialExpr(object) && isTrivialExpr(withoutTypeWrappers(index))
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

/**
 * An index without the type-level wrappers and parentheses around it. A type wrapper asserts
 * something about the index without replacing it (`TYPE_WRAPPER_TYPES`), so `a[i as number]`,
 * `a[i!]`, `a[<number>i]` and `obj[key as keyof T]` read what `a[i]` and `obj[key]` do. Only an
 * index is read through them: `isTrivialExpr` has no case for a wrapper, so `return x as T` is a
 * rule.
 */
function withoutTypeWrappers(index: Node): Node {
  let cursor = index
  while (TYPE_WRAPPER_TYPES.has(cursor.type) || cursor.type === "parenthesized_expression") {
    const inner = wrappedExpression(cursor)
    if (inner === null) return cursor
    cursor = inner
  }
  return cursor
}

/**
 * Whether `node`, an `if`'s consequence, can leave the flow the `if` sits in: a `throw` or
 * `process.exit()` anywhere in it, a `return`, or a `break`/`continue` whose target is outside
 * `node`.
 *
 * Code that only leaves something nested inside `node` does not count. A `return`, `break` or
 * `continue` inside a function written there, a class's methods included, or inside a class
 * static block cannot get past that function or block to the code the `if` guards. A `throw` or
 * `process.exit()` there still counts: a callback called synchronously throws or exits through
 * the `if`, and `readThrows` counts the same `throw` for the Symbol. An unlabeled `break` counts
 * only when no loop or `switch` inside `node` is nearer, an unlabeled `continue` only when no
 * loop is, and a labeled one only when its label is not declared inside `node`.
 */
function containsEarlyExit(node: Node): boolean {
  return exitsFrom(node, NO_INNER_TARGETS)
}

interface ExitScope {
  /** Inside a function or static block written in the consequence. */
  readonly inFunction: boolean
  readonly inLoop: boolean
  readonly inSwitch: boolean
  readonly labels: readonly string[]
}

/**
 * The scope a consequence is read from. It records only the loops, `switch`es and labels found
 * inside the consequence on the way down, never the ones around the `if`: a `break` or `continue`
 * that meets no target of its own inside the consequence ends something outside it, and that is
 * what makes `switch (k) { case "a": if (!ok) break; … }` a guard. Seeded from the enclosing
 * context instead, that `break` would read as staying inside and the guard would be lost.
 */
const NO_INNER_TARGETS: ExitScope = {
  inFunction: false,
  inLoop: false,
  inSwitch: false,
  labels: [],
}

/**
 * Nodes that no `return`, `break` or `continue` written inside them can leave, so none of those
 * counts there. They are still entered, for a `throw` or `process.exit()`, which do leave them.
 */
const EXIT_BOUNDARIES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
  "class_static_block",
])

function exitsFrom(node: Node, scope: ExitScope): boolean {
  switch (node.type) {
    case "throw_statement":
      return true
    case "return_statement":
      // In a function a `return` ends only that function, and its value is still read:
      // `return process.exit(1)` exits all the same.
      if (!scope.inFunction) return true
      break
    case "break_statement":
    case "continue_statement": {
      if (scope.inFunction) return false
      const label = node.childForFieldName("label")
      if (label !== null) return !scope.labels.includes(label.text)
      return node.type === "break_statement" ? !scope.inLoop && !scope.inSwitch : !scope.inLoop
    }
    case "call_expression": {
      const callee = node.childForFieldName("function")
      if (callee !== null && describeCallee(callee)?.target === "process.exit") return true
      break
    }
  }
  const inner = scopeInside(node, scope)
  for (const child of node.namedChildren) {
    if (child !== null && exitsFrom(child, inner)) return true
  }
  return false
}

/** The scope `node`'s children are read in: `scope` plus whatever target `node` opens. */
function scopeInside(node: Node, scope: ExitScope): ExitScope {
  if (EXIT_BOUNDARIES.has(node.type)) return { ...scope, inFunction: true }
  if (LOOP_KINDS.has(node.type)) return { ...scope, inLoop: true }
  if (node.type === "switch_statement") return { ...scope, inSwitch: true }
  if (node.type === "labeled_statement") {
    const label = node.childForFieldName("label")
    if (label !== null) return { ...scope, labels: [...scope.labels, label.text] }
  }
  return scope
}

/**
 * What `describeCallee` learned about one callee expression.
 *
 * `target` is the normalized string that lands in `CallCandidate.target` and
 * eventually in `Symbol.calls[].target` and `Symbol.effects[].target`. The
 * two flags beside it are passengers: neither is serialized, and neither
 * changes what `target` says. What the *string* says is wire-visible — a
 * bracket access contributes a segment (`lang-plugin.md`), and the logic
 * fingerprint reads `effects[].target`, so a change here moves IR bytes.
 */
interface CalleeShape {
  readonly target: string
  readonly dynamic: boolean
  readonly opaque: boolean
}

/**
 * The wrappers whose source text stands in for the name they wrap. Each asserts something
 * about a value without replacing it, so `svc!` still names `svc`, and `a[i!]` reads what
 * `a[i]` does (`withoutTypeWrappers`).
 *
 * `ast-helpers.ts` keeps a near twin, `VALUE_WRAPPER_TYPES`, for a different question (which
 * value a binding holds), and leaves `<T>x` off it. This set reads `<T>x` (`type_assertion`) as
 * well, through its own branch in `describeTypeWrapper`: a callee in a `.ts` file can be
 * written that way, since `.ts` files are parsed with the TypeScript grammar rather than tsx.
 */
const TYPE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "non_null_expression",
  "as_expression",
  "satisfies_expression",
  "type_assertion",
])

const UNMODELLED_EXPRESSION: CalleeShape = {
  target: COMPUTED_TARGET_SEGMENT,
  dynamic: true,
  opaque: false,
}

const META_PROPERTIES: ReadonlySet<string> = new Set(["import.meta", "new.target"])

/** ECMAScript's line terminators: LF, CR, LINE SEPARATOR and PARAGRAPH SEPARATOR. */
const LINE_BREAK = /[\n\r\u2028\u2029]/

function describeTypeWrapper(node: Node): CalleeShape | null {
  const innerNode = wrappedExpression(node)
  if (innerNode === null) return null
  const inner = describeCallee(innerNode)
  if (inner === null) return null
  if (inner.dynamic) return { target: inner.target, dynamic: true, opaque: false }
  if (LINE_BREAK.test(node.text)) return UNMODELLED_EXPRESSION
  if (node.text.split(".").some((segment) => segment.length === 0)) return UNMODELLED_EXPRESSION
  return { target: node.text, dynamic: false, opaque: true }
}

/**
 * The expression a wrapper wraps. The old-style `<T>x` puts the type first; the other type
 * wrappers and a parenthesis put the value first.
 */
function wrappedExpression(node: Node): Node | null {
  return node.type === "type_assertion"
    ? (node.namedChildren.at(-1) ?? null)
    : firstNonCommentChild(node)
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
    // The callee of a dynamic `import("./m")`, a keyword rather than an expression.
    case "import":
      return { target: "import", dynamic: false, opaque: false }
    // `import.meta` and `new.target` are fixed spellings that name a value, not expressions.
    case "meta_property":
      return META_PROPERTIES.has(node.text)
        ? { target: node.text, dynamic: false, opaque: false }
        : UNMODELLED_EXPRESSION
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
      const segment = subscriptSegment(node)
      if (segment === null) {
        return {
          target: `${inner.target}.${COMPUTED_TARGET_SEGMENT}`,
          dynamic: true,
          opaque: false,
        }
      }
      return {
        target: `${inner.target}.${segment}`,
        dynamic: inner.dynamic,
        opaque: inner.opaque,
      }
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
      if (TYPE_WRAPPER_TYPES.has(node.type)) return describeTypeWrapper(node)
      return node.text.length > 0 ? UNMODELLED_EXPRESSION : null
  }
}

function subscriptSegment(node: Node): string | null {
  if (hasErrorChild(node)) return null
  const index = node.childForFieldName("index")
  if (index === null) return null
  if (index.type !== "string" && index.type !== "template_string") return null
  const { value, whole } = decodeStringLiteral(index)
  return whole && isQnameSegment(value) ? value : null
}

function extractLiteral(node: Node): string | null {
  switch (node.type) {
    case "number":
    case "true":
    case "false":
    case "null":
    case "undefined":
      return node.text
    case "string":
    case "template_string":
      return readStaticString(node)
    default:
      return null
  }
}

function isUnderAwait(node: Node): boolean {
  return node.parent?.type === "await_expression"
}

function extractSwitchCondition(node: Node): string | null {
  const cond = node.childForFieldName("value") ?? node.childForFieldName("condition")
  return cond !== null ? conditionText(cond) : null
}

/**
 * A rule's `condition`, `what` or `expr` as ir-schema.md §8.2 writes it: the node's source
 * text with every comment inside it taken out, then whitespace-collapsed and cut to length by
 * `normalizeRuleText`.
 *
 * Comments go because fingerprint.md lists them among the edits `logic` does not see, and these
 * strings are `logic`'s input: a guard with a block comment between `qty <= 0` and
 * `|| unit < 0` is the guard `qty <= 0 || unit < 0`. Each one is replaced by a space rather
 * than by nothing, so a comment that was the only thing between two tokens still leaves them
 * apart: with a block comment as all that separates `a-` from `-b`, the guard is `a- -b`, where
 * `a--b` would read as a decrement.
 *
 * `from` / `to` narrow the text to part of the node: `conditionText` uses them to leave out
 * the parentheses, which no comment can sit outside of.
 */
function ruleText(node: Node, from = node.startIndex, to = node.endIndex): string {
  const source = node.text
  const base = node.startIndex
  // Every `comment` node opens with `//` or `/*`, so text without a `/` holds none, and the
  // walk below would only copy it.
  if (!source.includes("/")) return normalizeRuleText(source.slice(from - base, to - base))
  let out = ""
  let at = from
  for (const descendant of walkDescendants(node)) {
    if (descendant.type !== "comment") continue
    out += `${source.slice(at - base, descendant.startIndex - base)} `
    at = descendant.endIndex
  }
  out += source.slice(at - base, to - base)
  return normalizeRuleText(out)
}

function nullableRuleText(node: Node | undefined): string | null {
  return node === undefined ? null : ruleText(node)
}

/**
 * The condition of an `if` or a `switch` without the parentheses the statement requires around
 * it: `if (a && b)` has the condition `a && b`. Only that one pair goes, read off the tree — the
 * grammar wraps the condition in a `parenthesized_expression` whose first and last tokens are
 * they — so `if ((a) || (b))` keeps `(a) || (b)`.
 */
function conditionText(condition: Node): string {
  const open = condition.child(0)
  const close = condition.child(condition.childCount - 1)
  if (
    condition.type !== "parenthesized_expression" ||
    open?.type !== "(" ||
    close?.type !== ")" ||
    open.equals(close)
  ) {
    return ruleText(condition)
  }
  return ruleText(condition, open.endIndex, close.startIndex)
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
