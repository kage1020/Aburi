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

/** A returned value that is one call: recorded in `calls[]`, never a rule. */
function isCallOnly(value: Node): boolean {
  return value.type === "call_expression" || value.type === "new_expression"
}

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

function withoutTypeWrappers(index: Node): Node {
  let cursor = index
  while (TYPE_WRAPPER_TYPES.has(cursor.type) || cursor.type === "parenthesized_expression") {
    const inner = wrappedExpression(cursor)
    if (inner === null) return cursor
    cursor = inner
  }
  return cursor
}

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

const NO_INNER_TARGETS: ExitScope = {
  inFunction: false,
  inLoop: false,
  inSwitch: false,
  labels: [],
}

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

interface CalleeShape {
  readonly target: string
  readonly dynamic: boolean
  readonly opaque: boolean
}

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

function ruleText(node: Node, from = node.startIndex, to = node.endIndex): string {
  const source = node.text
  const base = node.startIndex
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
