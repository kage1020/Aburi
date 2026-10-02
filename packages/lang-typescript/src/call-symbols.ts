import type { ExtractionContext, MergedDeclaration, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { asFunctionValue, findChild, makeSourceRange, unwrapValue } from "./ast-helpers"
import { makeTsSymbolId, nestedQname } from "./qname"
import { readStaticString } from "./string-escape"

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

/** How many registrations of each `receiver__method__path` stem the module has produced so far. */
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
 *
 * Named `<receiver>__<method>__<discriminator>__d<N>`. The discriminator is the path slug when
 * the first argument is a literal string (quotes or a substitution-free backtick), otherwise the
 * names the arguments carry (`argumentNames`), and absent when neither says anything. `N` counts
 * earlier registrations with the same stem, so it is source order only among those.
 *
 * The `__d<N>` suffix is emitted UNCONDITIONALLY (even for the first occurrence). Skipping
 * it for `N=0` used to break Symbol.id uniqueness: `app.get('/x')` seen twice and
 * `app.get('/x__d1')` seen once would both collapse to `app__get__$x__d1`.
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

  const receiver = receiverSegment(parsed.receiver)
  if (receiver === null) return null

  const argsNode = call.childForFieldName("arguments") ?? findChild(call, "arguments")
  const literalPath = argsNode !== null ? firstStringLiteralArg(argsNode) : null
  // A path names a registration. Without one, the names its arguments carry do; the ordinal
  // below is left to separate only registrations that agree on both.
  const pathSlug =
    literalPath !== null
      ? slugifyPath(literalPath)
      : argsNode !== null
        ? argumentNames(argsNode)
        : ""

  const stem =
    pathSlug === "" ? `${receiver}__${parsed.method}` : `${receiver}__${parsed.method}__${pathSlug}`
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
 * Every function written as a direct argument of a call on `call`'s spine, as the bodies it
 * contributes to `declaration`, in source order.
 *
 * Two declarations hold such a function where no other declaration does: a registration
 * statement (`app.post('/x', async (req) => …)`, LP20g), whose Symbol is the call itself, and a
 * `const` initialised by a call (`const POST = withAuth(async (req) => …)`, LP7c). Either way the
 * Symbol stands for the whole declaration, so the scan covers every call on the spine, not only
 * the outermost: `app.route('/x').get(h1).post(h2)` registers two handlers and produces one
 * Symbol, and reading only the leaf's arguments would leave `h1` in no Symbol at all.
 *
 * Each body is paired with `declaration` rather than with the function it is the body of. The
 * bodies are further bodies of that one declaration (LP20h), and `normalizeAst` describes a
 * declaration once however many bodies it has, which it can only do if they all name it.
 *
 * **Direct** arguments only. A function inside an argument (`app.get('/x', wrap(() => …))`) is
 * a call's return value, which is the line `asFunctionValue` draws: reading through a call
 * would be a guess about what it returns. `asFunctionValue`'s set is also the answer to what
 * counts as a function here — an arrow or a function expression, wrapped or not. A generator
 * argument (Koa's `app.use(function* (ctx, next) {…})`) is outside it at every site that reads
 * the predicate, so it contributes no body.
 *
 * A body of no width is refused. A half-written function (`withAuth(async (req) =>)`) still
 * parses as an arrow whose `body` field is a zero-width error node. There is nothing in it to
 * walk, and adopting it would have the Symbol's `derivedBy` say it carries a function's body —
 * `inline-handler` on a registration, `call-argument-function` on a const — when it carries none.
 *
 * Ordered on `startIndex` because the spine is walked right-to-left, which is the reverse of
 * how the declaration is written.
 */
export function inlineHandlers(call: Node, declaration: Node): MergedDeclaration<Node>[] {
  const bodies: Node[] = []
  for (const step of spineCalls(call)) {
    const args = step.childForFieldName("arguments") ?? findChild(step, "arguments")
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

/** The path a registration's first argument spells, written with any quotes, backtick included. */
function firstStringLiteralArg(argsNode: Node): string | null {
  const first = argsNode.namedChildren[0]
  if (first === undefined || first === null) return null
  return readStaticString(first)
}

/**
 * What tells a registration with no path apart from the others of its method: the names its
 * arguments carry — an identifier (`authMw`), a dotted reference (`express.json`), or the callee
 * of a call (`cors()`, `express.static("public")`), each folded to a segment and joined by `$`.
 * Empty when no argument names anything: an inline function, a number, an object.
 *
 * Content, not position, because the ordinal is source order (ir-schema.md §3.3): with only the
 * bare `app__use` stem, inserting `app.use(compression())` above `app.use(cors())` renumbered
 * every later middleware, and the diff paired each one with the body its id used to hold. The
 * ordinal still separates registrations whose names agree, which is where position is all there
 * is.
 */
function argumentNames(argsNode: Node): string {
  const names: string[] = []
  for (const argument of argsNode.namedChildren) {
    if (argument === null) continue
    const name = referenceName(unwrapValue(argument))
    if (name !== null) names.push(name)
  }
  return names.join("$")
}

/** `a`, `a.b.c`, or the callee of `a.b()` — as a segment-safe string; null for anything else. */
function referenceName(node: Node): string | null {
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function")
    return callee === null ? null : referenceName(unwrapValue(callee))
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

function slugifyName(name: string): string {
  return Array.from(name)
    .map((ch) => foldChar(ch, SEGMENT_PART))
    .join("")
}

/** The characters `QNAME_SEGMENT_PATTERN` admits at the head of a segment, and after it. */
const SEGMENT_START = /[A-Za-z_$]/
const SEGMENT_PART = /[A-Za-z0-9_$]/

function foldChar(ch: string, allowed: RegExp): string {
  return allowed.test(ch) ? ch : "_"
}

/**
 * Turn a URL path literal into a segment-safe slug. `/` becomes `$`, `:` becomes `Z` (to
 * preserve dynamic-parameter positions in a way that stays alphanumeric), every other
 * non-identifier char is folded to `_`. Empty input returns "".
 */
function slugifyPath(path: string): string {
  let out = ""
  for (const ch of path) {
    out += ch === "/" ? "$" : ch === ":" ? "Z" : foldChar(ch, SEGMENT_PART)
  }
  return out
}

/**
 * The receiver identifier folded into a segment-safe form. Null on empty input — unreachable,
 * since `rootReceiver` already rejects an empty identifier, but kept so a future grammar
 * change cannot silently fabricate a shared placeholder qname.
 */
function receiverSegment(name: string): string | null {
  if (name.length === 0) return null
  return Array.from(name)
    .map((ch, i) => foldChar(ch, i === 0 ? SEGMENT_START : SEGMENT_PART))
    .join("")
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
