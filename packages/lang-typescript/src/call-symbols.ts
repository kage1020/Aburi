import type { ExtractionContext, MergedDeclaration, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import {
  asFunctionValue,
  findChild,
  firstNonCommentChild,
  makeSourceRange,
  unwrapValue,
} from "./ast-helpers"
import { makeTsSymbolId, nestedQname } from "./qname"
import { readStaticString } from "./string-escape"

const PROMOTABLE_METHOD_NAMES: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "use",
  "route",
  "listen",
  "param",
  "engine",
  "set",
  "enable",
  "disable",
])

export interface CallExtractionState {
  seen: Map<string, number>
}

export function makeCallExtractionState(): CallExtractionState {
  return { seen: new Map<string, number>() }
}

export function visitCallStatement(
  node: Node,
  ctx: ExtractionContext,
  state: CallExtractionState,
): SymbolCandidate<Node> | null {
  const call = firstCallExpression(node)
  if (call === null) return null
  const callee = call.childForFieldName("function") ?? call.namedChild(0)
  if (callee === null) return null
  const parsed = parseMemberCallee(callee)
  if (parsed === null) return null
  if (!PROMOTABLE_METHOD_NAMES.has(parsed.method)) return null

  const receiver = receiverSegment(parsed.receiver)
  if (receiver === null) return null

  const path = registrationPath(call)
  const argsNode = argumentsOf(call)
  const names = path === null && argsNode !== null ? argumentNames(argsNode) : ""
  const discriminator = path !== null ? slugifyPath(path) : names

  const stem =
    discriminator === ""
      ? `${receiver}__${parsed.method}`
      : `${receiver}__${parsed.method}__${discriminator}`
  const ordinal = state.seen.get(stem) ?? 0
  state.seen.set(stem, ordinal + 1)
  const qname = nestedQname([`${stem}__d${ordinal}`])

  const [lead, ...rest] = inlineHandlers(call, call)
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "call",
    extKind: null,
    name: qname,
    visibility: "internal",
    decorators: [],
    signature: null,
    source: makeSourceRange(call, ctx),
    derivedBy: makeDerivedBy(parsed, path, names, lead !== undefined),
    bodyNode: lead?.bodyNode ?? null,
    fullNode: call,
    ...(rest.length > 0 ? { mergedDeclarations: rest } : {}),
  }
}

export function inlineHandlers(call: Node, declaration: Node): MergedDeclaration<Node>[] {
  const bodies: Node[] = []
  for (const step of spineCalls(call)) {
    const args = argumentsOf(step)
    if (args === null) continue
    for (const argument of args.namedChildren) {
      if (argument === null) continue
      const handler = asFunctionValue(argument)
      if (handler === null) continue
      const body = handler.childForFieldName("body")
      if (body === null || body.text.length === 0) continue
      bodies.push(body)
    }
  }
  return bodies
    .sort((a, b) => a.startIndex - b.startIndex)
    .map((body) => ({ bodyNode: body, fullNode: declaration }))
}

function* spineCalls(call: Node): Iterable<Node> {
  let cursor: Node | null = call
  while (cursor !== null) {
    const step = unwrapValue(cursor)
    if (step.type === "call_expression") {
      yield step
      cursor = step.childForFieldName("function")
      continue
    }
    if (step.type === "member_expression") {
      cursor = step.childForFieldName("object")
      continue
    }
    cursor = null
  }
}

interface MemberCall {
  /** Root identifier on the left of the chain (e.g. `app` in `app.route('/x').get(h)`). */
  receiver: string
  /** Leaf method name (e.g. `get`). */
  method: string
  chained: boolean
}

function parseMemberCallee(callee: Node): MemberCall | null {
  if (callee.type !== "member_expression") return null
  const property = callee.childForFieldName("property")
  if (property === null) return null
  const method = property.text
  if (method.length === 0) return null

  const object = callee.childForFieldName("object")
  if (object === null) return null

  const root = rootReceiver(object)
  if (root === null) return null
  return { receiver: root.name, method, chained: root.chained }
}

function rootReceiver(node: Node): { name: string; chained: boolean } | null {
  let cursor: Node = unwrapValue(node)
  let chained = false
  while (true) {
    if (cursor.type === "identifier") {
      if (cursor.text.length === 0) return null
      return { name: cursor.text, chained }
    }
    if (cursor.type === "member_expression") {
      const object = cursor.childForFieldName("object")
      if (object === null) return null
      cursor = unwrapValue(object)
      continue
    }
    if (cursor.type === "call_expression") {
      const inner = cursor.childForFieldName("function")
      if (inner === null) return null
      chained = true
      cursor = unwrapValue(inner)
      continue
    }
    return null
  }
}

function firstCallExpression(exprStatement: Node): Node | null {
  for (const child of exprStatement.namedChildren) {
    if (child === null) continue
    if (child.type === "call_expression") return child
    if (child.type === "await_expression") {
      const inner = child.namedChild(0)
      if (inner !== null && inner.type === "call_expression") return inner
    }
  }
  return null
}

/** A call's argument list, or null when the parser recovered a call without one. */
function argumentsOf(call: Node): Node | null {
  return call.childForFieldName("arguments") ?? findChild(call, "arguments")
}

function registrationPath(call: Node): string | null {
  let path: string | null = null
  let at = Number.POSITIVE_INFINITY
  for (const step of spineCalls(call)) {
    const callee = step.childForFieldName("function")
    if (callee === null || unwrapValue(callee).type !== "member_expression") continue
    const args = argumentsOf(step)
    // The spine is walked outermost first, so the earliest-written list comes last.
    if (args === null || args.startIndex >= at) continue
    const literal = firstStringLiteralArg(args)
    if (literal === null || literal === "") continue
    path = literal
    at = args.startIndex
  }
  return path
}

function firstStringLiteralArg(argsNode: Node): string | null {
  const first = firstNonCommentChild(argsNode)
  return first === null ? null : readStaticString(unwrapValue(first))
}

function argumentNames(argsNode: Node): string {
  const names: string[] = []
  for (const argument of argsNode.namedChildren) {
    if (argument === null) continue
    const name = referenceName(unwrapValue(argument))
    if (name !== null) names.push(name)
  }
  return names.join("$")
}

function referenceName(node: Node): string | null {
  if (node.type === "call_expression") return fieldReferenceName(node, "function")
  if (node.type === "new_expression") return fieldReferenceName(node, "constructor")
  if (node.type === "spread_element") {
    const spread = firstNonCommentChild(node)
    return spread === null ? null : referenceName(unwrapValue(spread))
  }
  if (node.type === "identifier") return node.text.length === 0 ? null : slugifyName(node.text)
  if (node.type === "member_expression") {
    const object = node.childForFieldName("object")
    const property = node.childForFieldName("property")
    if (object === null || property === null || property.text.length === 0) return null
    const head = referenceName(unwrapValue(object))
    return head === null ? null : `${head}_${slugifyName(property.text)}`
  }
  return null
}

function fieldReferenceName(node: Node, field: string): string | null {
  const child = node.childForFieldName(field)
  return child === null ? null : referenceName(unwrapValue(child))
}

function slugifyName(name: string): string {
  return toNfc(Array.from(name, (ch) => foldChar(ch, SEGMENT_PART)).join(""))
}

const SEGMENT_START = /[$_\p{ID_Start}]/u
const SEGMENT_PART = /[$\p{ID_Continue}]/u

function foldChar(ch: string, allowed: RegExp): string {
  return allowed.test(ch) ? ch : "_"
}

function toNfc(value: string): string {
  return value.normalize("NFC")
}

function slugifyPath(path: string): string {
  let out = ""
  for (const ch of path) {
    out += ch === "/" ? "$" : ch === ":" ? "Z" : foldChar(ch, SEGMENT_PART)
  }
  return toNfc(out)
}

function receiverSegment(name: string): string | null {
  if (name.length === 0) return null
  return toNfc(
    Array.from(name, (ch, i) => foldChar(ch, i === 0 ? SEGMENT_START : SEGMENT_PART)).join(""),
  )
}

function makeDerivedBy(
  parsed: MemberCall,
  path: string | null,
  names: string,
  hasInlineHandler: boolean,
): string[] {
  const tags: string[] = [`call-statement:${parsed.receiver}.${parsed.method}`]
  if (parsed.chained) tags.push("chained-call")
  if (path !== null) tags.push(`path-literal:${path}`)
  else if (names !== "") tags.push(`argument-names:${names}`)
  // Says why a Symbol whose declaration is a call has a body at all.
  if (hasInlineHandler) tags.push("inline-handler")
  return tags
}
