import type { ExtractionContext, MergedDeclaration, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { asFunctionValue, makeSourceRange, unwrapValue } from "./ast-helpers"
import { makeTsSymbolId, nestedQname } from "./qname"

/**
 * Framework-level method vocabulary that promotes a module-level chained call
 * (`app.get('/foo', handler)`) into a Symbol. This is deliberately Express-shaped
 * today — the extractor is language-generic, but no other framework is registered
 * against this surface yet. Additions land here as new frameworks come online.
 */
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

/**
 * The `__d<N>` suffix is emitted UNCONDITIONALLY (even for the first occurrence). Skipping
 * it for `N=0` used to break Symbol.id uniqueness: `app.get('/x')` seen twice and
 * `app.get('/x__d1')` seen once would both collapse to `app__get__$x__d1`.
 */
export interface CallExtractionState {
  seen: Map<string, number>
}

export function makeCallExtractionState(): CallExtractionState {
  return { seen: new Map<string, number>() }
}

/**
 * Emit a `kind: "call"` SymbolCandidate for a module-level expression statement whose
 * inner call_expression is a chained member call (`receiver.method(...)`). Ignores calls
 * whose leaf method is not in `PROMOTABLE_METHOD_NAMES` — the goal is to surface only
 * framework registration shapes (Express in particular), not arbitrary expression
 * statements.
 */
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

  const receiverSegment = mangleReceiver(parsed.receiver)
  if (receiverSegment === null) return null

  const argsNode = call.childForFieldName("arguments") ?? findArgumentsChild(call)
  const literalPath = argsNode !== null ? firstStringLiteralArg(argsNode) : null
  const pathSlug = literalPath === null ? "" : slugifyPath(literalPath)

  const baseQname =
    pathSlug === ""
      ? `${receiverSegment}__${parsed.method}`
      : `${receiverSegment}__${parsed.method}__${pathSlug}`

  const count = state.seen.get(baseQname) ?? 0
  state.seen.set(baseQname, count + 1)
  const finalQname = `${baseQname}__d${count}`

  const qname = nestedQname([finalQname])
  const [lead, ...rest] = inlineHandlers(call)
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "call",
    extKind: null,
    name: qname,
    visibility: "internal",
    decorators: [],
    // The registration's own API, which is nothing: a route has no parameters, and reading
    // the handler's would publish the framework's callback shape as the route's signature.
    signature: null,
    source: makeSourceRange(call, ctx),
    derivedBy: makeDerivedBy(parsed, literalPath, lead !== undefined),
    bodyNode: lead?.bodyNode ?? null,
    fullNode: call,
    // Absent, never empty — `plugins.ts` states the contract and LP8i pins it.
    ...(rest.length > 0 ? { mergedDeclarations: rest } : {}),
  }
}

/**
 * Every function written as a direct argument of the registration, as the bodies they
 * contribute, in source order.
 *
 * The Symbol stands for the whole statement, so the scan covers every call on the statement's
 * spine, not only the outermost: `app.route('/x').get(h1).post(h2)` registers two handlers and
 * produces one Symbol, and reading only the leaf's arguments would leave `h1` in no Symbol at
 * all.
 *
 * **Direct** arguments only. A function inside an argument (`app.get('/x', wrap(() => …))`) is
 * a call's return value, which is the line `asFunctionValue` draws: reading through a call
 * would be a guess about what it returns. `asFunctionValue`'s set is also the answer to what
 * counts as a function here — an arrow or a function expression, wrapped or not. A generator
 * argument (Koa's `app.use(function* (ctx, next) {…})`) is outside it at every site that reads
 * the predicate, so it registers no body.
 *
 * A body of no width is refused. A half-written handler (`app.get('/x', async (req) =>)`) still
 * parses as an arrow whose `body` field is a zero-width error node; adopting it would describe
 * every broken handler in a workspace with the same string, and claim `inline-handler` for a
 * function that has no body to walk.
 *
 * Ordered on `startIndex` because the spine is walked right-to-left, which is the reverse of
 * how the statement is written.
 */
function inlineHandlers(call: Node): MergedDeclaration<Node>[] {
  const found: MergedDeclaration<Node>[] = []
  for (const step of spineCalls(call)) {
    const args = step.childForFieldName("arguments") ?? findArgumentsChild(step)
    if (args === null) continue
    for (const argument of args.namedChildren) {
      if (argument === null) continue
      const handler = asFunctionValue(argument)
      if (handler === null) continue
      const body = handler.childForFieldName("body")
      if (body === null || body.text.length === 0) continue
      found.push({ bodyNode: body, fullNode: handler })
    }
  }
  return found.sort((a, b) => a.fullNode.startIndex - b.fullNode.startIndex)
}

/**
 * Every call on the statement's spine, outermost first.
 *
 * The spine is what `rootReceiver` walks to find the receiver, and this walks it for the same
 * reason: one statement is one Symbol, so every registration written in it belongs to that
 * Symbol. `app.use(h0).router.get(h1)` reaches `.use`'s call through a member step, and
 * stopping at that step would leave `h0` in no Symbol at all.
 *
 * Read through the same wrappers a value is read through, so a chain does not end at a
 * parenthesis or a type assertion written in the middle of it.
 */
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
  /** True when the receiver was reached through one or more intermediate `.call()` steps
   * (e.g. `app.route('/x').get(h)` — the receiver `app` is the root, but the immediate
   * left of `.get` is a call expression). */
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

/**
 * The identifier the statement's chain starts from, and whether a call stands between it and
 * the leaf method.
 *
 * Wrappers are read through by the same reader the value side uses, so `(app as Express).get()`
 * and `app!.get()` name the same receiver `app.get()` does. Hand-unwrapping only parentheses
 * here left the two readers disagreeing about what a wrapper is (LP7a).
 */
function rootReceiver(node: Node): { name: string; chained: boolean } | null {
  let cursor: Node = unwrapValue(node)
  let chained = false
  while (true) {
    if (cursor.type === "identifier") {
      // Reject empty identifier text (malformed AST). Manufacturing a placeholder here
      // would silently collide with every other broken identifier in the workspace.
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

function findArgumentsChild(callExpression: Node): Node | null {
  for (const child of callExpression.namedChildren) {
    if (child !== null && child.type === "arguments") return child
  }
  return null
}

function firstStringLiteralArg(argsNode: Node): string | null {
  const first = argsNode.namedChildren[0]
  if (first === undefined || first === null) return null
  if (first.type !== "string") return null
  const parts: string[] = []
  for (const child of first.namedChildren) {
    if (child === null) continue
    if (child.type === "string_fragment") parts.push(child.text)
  }
  if (parts.length > 0) return parts.join("")
  const raw = first.text
  return raw.length >= 2 ? raw.slice(1, -1) : raw
}

/**
 * Turn a URL path literal into a QNAME_SEGMENT_PATTERN-safe slug. `/` becomes `$`, `:`
 * becomes `Z` (to preserve dynamic-parameter positions in a way that stays alphanumeric),
 * every other non-identifier char is folded to `_`. Empty input returns "".
 */
function slugifyPath(path: string): string {
  if (path.length === 0) return ""
  let out = ""
  for (const ch of path) {
    if (ch === "/") {
      out += "$"
      continue
    }
    if (ch === ":") {
      out += "Z"
      continue
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      out += ch
      continue
    }
    out += "_"
  }
  return out
}

/**
 * Force the receiver token into a QNAME_SEGMENT_PATTERN-safe form. Returns null on empty
 * input (should be unreachable — `rootReceiver` already rejects empty identifiers — but
 * kept as a defensive gate so a future grammar change cannot silently fabricate a shared
 * placeholder qname).
 */
function mangleReceiver(name: string): string | null {
  if (name.length === 0) return null
  let out = ""
  for (const [i, ch] of Array.from(name).entries()) {
    if (i === 0) {
      out += /[A-Za-z_$]/.test(ch) ? ch : "_"
      continue
    }
    out += /[A-Za-z0-9_$]/.test(ch) ? ch : "_"
  }
  return out
}

function makeDerivedBy(
  parsed: MemberCall,
  literalPath: string | null,
  hasInlineHandler: boolean,
): string[] {
  const tags: string[] = [`call-statement:${parsed.receiver}.${parsed.method}`]
  if (parsed.chained) tags.push("chained-call")
  if (literalPath !== null) tags.push(`path-literal:${literalPath}`)
  // Says why a Symbol whose declaration is a call has a body at all.
  if (hasInlineHandler) tags.push("inline-handler")
  return tags
}
