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
 * How many registrations of each `<receiver>__<method>__<discriminator>` stem the module has
 * produced so far.
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
 *
 * Named `<receiver>__<method>__<discriminator>__d<N>`. The discriminator is the path slug when a
 * call on the chain is handed a path (`registrationPath`), otherwise the names the leaf call's
 * arguments carry (`argumentNames`), and absent when neither says anything. `N` counts earlier
 * registrations with the same stem, so it is source order only among those: the uniqueness
 * tiebreaker ir-schema.md §3.3 admits, never the name.
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

  // A path names a registration. Without one, the names its arguments carry do; the ordinal
  // below is left to separate only registrations that agree on the discriminator.
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
    // The registration's own API, which is nothing: a route has no parameters, and reading
    // the handler's would publish the framework's callback shape as the route's signature.
    signature: null,
    source: makeSourceRange(call, ctx),
    derivedBy: makeDerivedBy(parsed, path, names, lead !== undefined),
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

/** A call's argument list, or null when the parser recovered a call without one. */
function argumentsOf(call: Node): Node | null {
  return call.childForFieldName("arguments") ?? findChild(call, "arguments")
}

/**
 * The path a registration is mounted at: the earliest-written first argument, among the method
 * calls on the statement's chain, that is a literal string with something in it. Null when
 * none is.
 *
 * The chain, not only the leaf call, because the chain is one statement and one Symbol (LP20g):
 * `app.route('/a').get(h)` writes its path one call up the spine, and reading only `.get(h)`
 * named it by the handler, so `app.route('/b').get(h)` shared its stem and the two were told
 * apart by order alone. Earliest, because a path written further left is the one the rest of
 * the chain hangs off. Method calls only: a call that *starts* the chain
 * (`require("express")().get(h)`, `createApp("/base").get(h)`) is what makes the receiver, and
 * its argument is not a path the registration is mounted at.
 *
 * An empty literal (`app.get("", h)`) says nothing a slug could keep, so it is passed over and
 * the names the arguments carry stand in, as for no literal at all; tagging it `path-literal:`
 * would claim a path the id does not contain.
 */
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

/**
 * The string a call's first argument spells, written with any quotes, backtick included; null
 * when it is not a literal string.
 *
 * Read past a comment and through the wrappers a value is read through (`firstNonCommentChild`,
 * `unwrapValue`), as `argumentNames` reads its arguments. `"/users" as string`, `("/users")` and
 * `"/users"` with a comment written in front of it register the route `"/users"` does, and
 * taking the first child by position found the wrapper or the comment instead, so adding a
 * comment above a route's path renamed the route.
 */
function firstStringLiteralArg(argsNode: Node): string | null {
  const first = firstNonCommentChild(argsNode)
  return first === null ? null : readStaticString(unwrapValue(first))
}

/**
 * What tells a registration with no path apart from the others of its method: the names its
 * arguments carry (`referenceName`), each folded to a segment and joined by `$`. Empty when no
 * argument names anything: an inline function, a number, an object.
 *
 * Content, not position, because the ordinal is source order (ir-schema.md §3.3): with only the
 * bare `app__use` stem, inserting `app.use(compression())` above `app.use(cors())` renumbered
 * every later middleware, and the diff paired each one with the body its id used to hold. The
 * ordinal still separates registrations whose names agree, which is where position is all there
 * is.
 *
 * Only the leaf call's arguments are read, and only for a registration with no path: a path
 * names the registration on its own, and a middleware added to a route
 * (`app.get("/x", h)` → `app.get("/x", auth, h)`) is an edit to that route rather than a new
 * one. What a call is handed is not read either (`express.static("public")` is
 * `express_static`), so renaming a directory does not rename the registration serving it.
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

/**
 * The name a reference spells, as a segment-safe string, or null when it spells none.
 *
 * An identifier is itself (`authMw`), and a property access joins its object's name to its
 * property with `_`, at any depth (`a.b.c` → `a_b_c`). A call answers for its callee, a `new`
 * for its constructor and a spread for what it spreads, wherever they stand in a dotted path:
 * `cors()` → `cors`, `new Logger()` → `Logger`, `...mws` → `mws`, `a.b().c` → `a_b_c`.
 * Wrappers are read through at every step. Anything else — a literal, an inline function, an
 * object — names nothing.
 */
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

/**
 * The characters `QNAME_SEGMENT_PATTERN` in `@aburi/core` admits at the head of a segment, and
 * after it: ECMAScript's IdentifierName, so `app.use(認証)` and `app.use(圧縮)` keep their names
 * rather than both folding to `__`. `ID_Continue` covers the digits and `ID_Start` does not,
 * which is the head rule; ZWNJ and ZWJ are already in `ID_Continue` on the Node version the
 * workspace pins, as the pattern's own doc measures.
 */
const SEGMENT_START = /[$_\p{ID_Start}]/u
const SEGMENT_PART = /[$\p{ID_Continue}]/u

function foldChar(ch: string, allowed: RegExp): string {
  return allowed.test(ch) ? ch : "_"
}

/**
 * Unicode NFC, the form every string in a Document is held in (ir-schema.md §1.2).
 *
 * The segment becomes `symbols[].name`, which invariant #19 holds to NFC, and an identifier or
 * a path read from source carries whichever spelling the file was saved in, so a composed and a
 * decomposed `café` would otherwise be two names. It is the folded text that is normalized, not
 * the source text, because folding can itself leave a pair NFC composes: `:` becomes `Z`, and a
 * combining acute written after it then composes to `Ź`.
 */
function toNfc(value: string): string {
  return value.normalize("NFC")
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
  return toNfc(out)
}

/**
 * The receiver identifier folded into a segment-safe form. Null on empty input — unreachable,
 * since `rootReceiver` already rejects an empty identifier, but kept so a future grammar
 * change cannot silently fabricate a shared placeholder qname.
 */
function receiverSegment(name: string): string | null {
  if (name.length === 0) return null
  return toNfc(
    Array.from(name, (ch, i) => foldChar(ch, i === 0 ? SEGMENT_START : SEGMENT_PART)).join(""),
  )
}

/**
 * Says where the name came from. `path-literal:<path>` and `argument-names:<slug>` are
 * exclusive, as the discriminators they report are, and neither is written when the name has
 * none.
 *
 * The stem alone cannot say which it was: `$` is both a path's `/` and the argument-name
 * joiner, so `app.use($api)` and `app.use("/api", x)` share `app__use__$api`, and only the tag
 * tells them apart. It does not undo the fold: `_` is both a member's `.` and the replacement
 * for a character the segment grammar refuses, so `express.json` and `express_json` are one
 * slug in the tag as in the stem, and the ordinal separates them.
 */
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
