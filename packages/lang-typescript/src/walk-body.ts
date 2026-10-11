import type {
  BodyExtraction,
  CallCandidate,
  Rule,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { bodyNodesOf, thrownValue } from "./ast-helpers"
import { readCall } from "./callee"
import { functionValuedField, isConstructorMember, memberSymbolSegment } from "./class-members"
import { containsEarlyExit } from "./early-exit"
import { objectEntryOf } from "./object-members"
import { conditionText, isTrivialExpr, LOOP_KINDS, makeRule, ruleText } from "./rules"

export function walkBody(symbol: SymbolCandidate<Node>, _ctx: WalkContext<Node>): BodyExtraction {
  const rules: Rule[] = []
  const calls: CallCandidate[] = []
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

function memberBodySkippedHere(classNode: Node, member: Node): Node | null {
  if (memberSymbolSegment(classNode, member) === null) return null
  if (isConstructorMember(member)) return null
  return (functionValuedField(member) ?? member).childForFieldName("body")
}

function visitNode(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const loopKind = LOOP_KINDS.get(node.type)
  if (loopKind !== undefined) {
    rules.push(makeRule("loop", node, { loopKind }))
    visitChildren(node, rules, calls)
    return
  }
  switch (node.type) {
    case "if_statement":
      visitIfStatement(node, rules, calls)
      return
    case "throw_statement": {
      const thrown = thrownValue(node)
      rules.push(makeRule("throw", node, { what: thrown === null ? null : ruleText(thrown.node) }))
      visitCallsInside(node, calls)
      return
    }
    case "return_statement":
      visitReturnStatement(node, rules, calls)
      return
    case "try_statement":
      rules.push(makeRule("try", node))
      visitTryStatement(node, rules, calls)
      return
    case "switch_statement":
      rules.push(makeRule("switch", node, { condition: switchCondition(node) }))
      visitChildren(node, rules, calls)
      return
    case "call_expression":
    case "new_expression":
      recordCall(node, calls)
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

function recordCall(node: Node, calls: CallCandidate[]): void {
  const call = readCall(node)
  if (call !== null) calls.push(call)
}

function visitCallsInside(node: Node, calls: CallCandidate[]): void {
  for (const child of node.namedChildren) {
    if (child === null) continue
    if (isCall(child)) recordCall(child, calls)
    visitCallsInside(child, calls)
  }
}

function visitIfStatement(node: Node, rules: Rule[], calls: CallCandidate[]): void {
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

function visitReturnStatement(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const value = node.namedChildren[0] ?? null
  if (value === null) return
  if (isCall(value)) {
    recordCall(value, calls)
    visitChildren(value, rules, calls)
    return
  }
  if (isTrivialExpr(value)) return
  rules.push(makeRule("return", node, { expr: ruleText(value) }))
  visitChildren(value, rules, calls)
}

function visitConciseBody(body: Node, rules: Rule[], calls: CallCandidate[]): void {
  const value = unparenthesized(body)
  if (!isCall(value) && !isTrivialExpr(value)) {
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

function isCall(node: Node): boolean {
  return node.type === "call_expression" || node.type === "new_expression"
}

function visitTryStatement(node: Node, rules: Rule[], calls: CallCandidate[]): void {
  const body = node.childForFieldName("body")
  if (body !== null) visitNode(body, rules, calls)
  const handler = node.childForFieldName("handler")
  const withheld: Rule[] = []
  if (handler !== null) visitNode(handler, withheld, calls)
  const finalizer = node.childForFieldName("finalizer")
  if (finalizer !== null) visitNode(finalizer, rules, calls)
}

function switchCondition(node: Node): string | null {
  const cond = node.childForFieldName("value") ?? node.childForFieldName("condition")
  return cond !== null ? conditionText(cond) : null
}
