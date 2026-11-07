import { chainCalls, readStaticString, unwrapValue, walkReceiverChain } from "@aburi/core"
import {
  CALL_ARGUMENT_FUNCTION_DERIVED_BY,
  type ExtractionContext,
  INVOKED_FUNCTION_DERIVED_BY,
  type MergedDeclaration,
  type SymbolCandidate,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { asFunctionValue, findChild, firstNonCommentChild, makeSourceRange } from "./ast-helpers"
import { makeTsSymbolId, nestedQname } from "./qname"

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

  const handlers = inlineHandlers(call)
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "call",
    extKind: null,
    name: qname,
    visibility: "internal",
    decorators: [],
    signature: null,
    source: makeSourceRange(call, ctx),
    derivedBy: makeDerivedBy(parsed, path, names, handlers.length > 0),
    // Handed no function, the registration defers nothing: what it runs is the call, on import.
    ...layOutBodies(handlers.length > 0 ? handlers : [call], call),
  }
}

export function wrappedFunctions(value: Node): Node[] {
  const call = unwrapValue(value)
  return call.type === "call_expression" ? inlineHandlers(call) : []
}

export interface CallFunctions {
  bodies: Node[]
  evidence: string[]
}

export function callFunctions(value: Node): CallFunctions {
  const unwrapped = unwrapValue(value)
  const awaited = unwrapped.type === "await_expression"
  const operand = awaited ? firstNonCommentChild(unwrapped) : unwrapped
  const call = operand === null ? null : unwrapValue(operand)
  if (call?.type !== "call_expression") return { bodies: [], evidence: [] }
  // An invoked function runs whether or not its result is awaited. An awaited call's value is what
  // it resolves to, not a function wrapping the ones it is handed.
  const invoked = invokedBody(call)
  const handed = awaited ? [] : inlineHandlers(call)
  return {
    bodies: invoked === null ? handed : [invoked, ...handed],
    evidence: [
      ...(invoked === null ? [] : [INVOKED_FUNCTION_DERIVED_BY]),
      ...(handed.length === 0 ? [] : [CALL_ARGUMENT_FUNCTION_DERIVED_BY]),
    ],
  }
}

export function layOutBodies(
  bodies: readonly Node[],
  declaration: Node,
): Pick<SymbolCandidate<Node>, "bodyNode" | "fullNode" | "mergedDeclarations"> {
  const [lead, ...rest] = bodies
  const merged = rest.map(
    (body): MergedDeclaration<Node> => ({ bodyNode: body, fullNode: declaration }),
  )
  return {
    bodyNode: lead ?? null,
    fullNode: declaration,
    ...(merged.length > 0 ? { mergedDeclarations: merged } : {}),
  }
}

function inlineHandlers(call: Node): Node[] {
  const bodies: Node[] = []
  for (const step of chainCalls(call)) {
    const args = argumentsOf(step)
    if (args === null) continue
    for (const argument of args.namedChildren) {
      if (argument === null) continue
      const handler = asFunctionValue(argument)
      const body = handler === null ? null : writtenBody(handler)
      if (body !== null) bodies.push(body)
    }
  }
  return bodies.sort((a, b) => a.startIndex - b.startIndex)
}

function invokedBody(call: Node): Node | null {
  const callee = chainCalls(call).at(-1)?.childForFieldName("function") ?? null
  const invoked = callee === null ? null : asFunctionValue(callee)
  return invoked === null ? null : writtenBody(invoked)
}

// A body of no width is the parser's stand-in for one that was not written.
function writtenBody(fn: Node): Node | null {
  const body = fn.childForFieldName("body")
  return body === null || body.text.length === 0 ? null : body
}

interface MemberCall {
  receiver: string
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

// A name through an index would drop what the index picks (`routers["admin"].get` and
// `routers["user"].get` alike), and a root that is not a name, `this` included, has none to slug.
function rootReceiver(node: Node): { name: string; chained: boolean } | null {
  const { steps, root } = walkReceiverChain(node)
  if (root.type !== "identifier" || root.text.length === 0) return null
  if (steps.some((step) => step.type === "subscript_expression")) return null
  return { name: root.text, chained: steps.some((step) => step.type === "call_expression") }
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

function argumentsOf(call: Node): Node | null {
  return call.childForFieldName("arguments") ?? findChild(call, "arguments")
}

function registrationPath(call: Node): string | null {
  let path: string | null = null
  let at = Number.POSITIVE_INFINITY
  for (const step of chainCalls(call)) {
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
  if (hasInlineHandler) tags.push("inline-handler")
  return tags
}
