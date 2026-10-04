import { compareCodeUnit } from "@aburi/core"
import type { Signature } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, thrownValue, walkDescendants } from "./ast-helpers"
import { collectPatternBindings, isRepairedPattern } from "./pattern-bindings"

/**
 * Build a Signature for a function-like declaration node (function_declaration,
 * method_definition, arrow_function, function_expression, etc.).
 *
 * Rules that mirror lang-plugin.md / fingerprint.md:
 * - `inputs[].name` is the binding as written: an identifier, `this`, or the source text of a
 *   destructuring pattern. A rest parameter's `...` is not part of it (`readParameter`).
 * - `inputs[].optional` / `inputs[].rest` record what a caller sees of the parameter's form,
 *   and are written only when true (LP11b).
 * - `inputs[].bindings` lists the names a destructuring parameter binds, and is absent for
 *   a parameter that is a single name and for a pattern that binds none, as `{}` (LP11d).
 * - `inputs[].type` and `outputs[]` are the AST-visible type text; we do not resolve
 *   types.
 * - `throws[]` is the union of explicit `throw new X()` statements inside the body plus
 *   `@throws` tags in the JSDoc block preceding the declaration.
 * - `typeParameters[]` carries the raw text of each type parameter (`T`, `T extends X`, …).
 */
export function buildSignature(declaration: Node, jsDocText: string | null): Signature {
  const async = detectAsync(declaration)
  const generator = detectGenerator(declaration)
  const typeParameters = readTypeParameters(declaration)
  const inputs = readParameters(declaration)
  const outputs = readReturnType(declaration)
  const throws = readThrows(declaration, jsDocText)
  return { async, generator, inputs, outputs, throws, typeParameters }
}

function detectAsync(node: Node): boolean {
  for (const child of node.children) {
    if (child !== null && child.type === "async") return true
  }
  return false
}

function detectGenerator(node: Node): boolean {
  for (const child of node.children) {
    if (child !== null && (child.type === "*" || child.type === "generator")) return true
  }
  return false
}

function readTypeParameters(node: Node): string[] {
  const params = node.childForFieldName("type_parameters") ?? findChild(node, "type_parameters")
  if (params === null) return []
  const out: string[] = []
  for (const child of params.namedChildren) {
    if (child === null || child.type !== "type_parameter") continue
    out.push(child.text.trim())
  }
  return out
}

function readParameters(node: Node): Signature["inputs"] {
  const params = node.childForFieldName("parameters") ?? findChild(node, "formal_parameters")
  if (params === null) return readBareParameter(node)
  const out: Signature["inputs"] = []
  // TypeScript's grammar writes every parameter as one of these two; a rest parameter is a
  // `required_parameter` whose pattern is a `rest_pattern`, which is where `readParameter`
  // reads it.
  for (const child of params.namedChildren) {
    if (child === null) continue
    if (child.type === "required_parameter" || child.type === "optional_parameter") {
      out.push(readParameter(child))
    }
  }
  return out
}

/**
 * A parenthesis-free arrow — `x => x + 1` — has no parameter list to read: the grammar
 * hangs its single binding off a `parameter` field as a bare identifier, so the list
 * lookup above finds nothing and the function would report itself zero-arity. The api
 * fingerprint (fingerprint.md) compares `inputs` positionally, so that reading
 * reports the wrong arity, and wrongly in both directions: `x => …` → `() => …` drops
 * the parameter and is reported as no change at all, while `x => …` → `(x) => …` leaves
 * the contract alone and is reported as an api change.
 *
 * The form admits no type annotation, so the input is untyped: the same empty `type` an
 * unannotated `(x) => …` produces, which keeps the two spellings of one parameter one
 * signature.
 */
function readBareParameter(node: Node): Signature["inputs"] {
  const parameter = node.childForFieldName("parameter")
  if (parameter === null) return []
  const name = parameter.text.trim()
  if (name.length === 0) return []
  return [{ name, type: "" }]
}

/**
 * One parameter: its binding, its written type, and two fields for what a caller sees of its
 * form — `optional` when a call may leave the argument out (`a?: T`, or a default as in
 * `a = 10`) and `rest` when the parameter collects the remaining arguments (`...ids: T[]`).
 * They are fields because the api fingerprint hashes them, and does not hash `name`
 * (fingerprint.md §3.1, §3.4). Renderers print them in the parameter's spelling: `a?: T`,
 * `...ids: T[]`, and `limit?` for a default. The default's value is not recorded here: it is
 * not part of the api contract, and the body walk reads it with the body (LP20d), so what it
 * runs reaches the logic axis. A binding that destructures also lists the names it binds, in
 * `bindings` (`readPatternBindings`).
 *
 * `name` is the binding's own text, without a rest parameter's `...`. A recovered parse can
 * leave no binding to read. For `...: T[]` the parser inserts a zero-width MISSING identifier,
 * and in a method it can wrap the `:` of `...: T` in an ERROR node instead. fingerprint.md
 * §5.1(6) treats a MISSING node as not written, and an ERROR node is no binding, so the name
 * falls back to the text of the nearest enclosing node the source did write: the pattern
 * (`...`), else the whole parameter (`?: string`). The parser only builds a parameter around
 * something it read, so that text is never empty. Neither rule gives way: nothing the parser
 * invented becomes a name, and no name is the empty string the schema's `minLength: 1`
 * refuses.
 */
function readParameter(param: Node): Signature["inputs"][number] {
  const pattern = param.childForFieldName("pattern") ?? param.namedChild(0)
  const rest = pattern !== null && pattern.type === "rest_pattern"
  const binding = rest ? pattern.namedChild(0) : pattern
  const input: Signature["inputs"][number] = {
    name: writtenText(binding) ?? writtenText(pattern) ?? param.text,
    type: extractParamType(param),
  }
  if (param.type === "optional_parameter" || param.childForFieldName("value") !== null) {
    input.optional = true
  }
  if (rest) input.rest = true
  const bindings = readPatternBindings(binding)
  if (bindings.length > 0) input.bindings = bindings
  return input
}

/** The node's source text, or null where the source wrote no binding there. */
function writtenText(node: Node | null): string | null {
  if (node === null || node.isMissing || node.type === "ERROR") return null
  return node.text
}

/**
 * The names a destructuring parameter binds — `{ save }`, `[save]`, `{ persist: save }`,
 * `{ save = fallback }`, `...[save]` all bind `save`. The `name` beside them is the
 * pattern's text, which binds nothing by that spelling, so without this list the call
 * resolver's parameter shadow (call-resolution.md §4.2) never sees these names and links
 * `save()` to whatever `save` the file imports.
 *
 * `binding` is what `readParameter` names the input by, so a rest parameter arrives here
 * already without its `...`: `...[save]` is read as `[save]`, and `...save` as the single name
 * `save`. A single name returns nothing, rest or not: its `name` already is the binding, and
 * the key stays absent (Class B).
 *
 * Only a name the parser placed in binding position is listed. A zero-width MISSING identifier
 * (`{ a: }`) is a name the source did not write, for the reason `readParameter` never names an
 * input by one, and its empty text is one the schema's `minLength: 1` refuses. The walk skips
 * an ERROR node, text the parser could not place (`{ a b }`), and an expression the grammar
 * places where a binding belongs (`{ a: obj.b, c }`), and lists the names around them: those
 * two bind `a` and `c`. A destructuring declaration refuses both, but here a refusal would drop
 * the whole file over one parameter whose `name` is still its written text. Where the parser
 * kept a malformed array pattern only as an expression behind a `!` it inserted, the walk reads
 * the expression as the pattern it spells, so `[a, ?, b]` binds `a` and `b`
 * (`isRepairedPattern`).
 */
function readPatternBindings(binding: Node | null): string[] {
  if (binding === null) return []
  const destructures =
    binding.type === "object_pattern" ||
    binding.type === "array_pattern" ||
    isRepairedPattern(binding)
  if (!destructures) return []
  const out: string[] = []
  for (const node of collectPatternBindings(binding, "skip")) {
    const name = writtenText(node)
    if (name !== null) out.push(name)
  }
  return out
}

function extractParamType(param: Node): string {
  const typeAnn = param.childForFieldName("type") ?? findChild(param, "type_annotation")
  if (typeAnn === null) return ""
  // type_annotation is `: T` — strip the leading colon so the returned string is the type
  // expression alone. Grammar-wise the first named child is the actual type.
  const inner = typeAnn.namedChild(0)
  return inner !== null ? inner.text.trim() : typeAnn.text.replace(/^:\s*/, "").trim()
}

function readReturnType(node: Node): string[] {
  const returnType = node.childForFieldName("return_type") ?? findChild(node, "type_annotation")
  if (returnType === null) return []
  const inner = returnType.namedChild(0)
  const text = (inner !== null ? inner.text : returnType.text.replace(/^:\s*/, "")).trim()
  return text.length > 0 ? [text] : []
}

function readThrows(node: Node, jsDocText: string | null): string[] {
  const seen = new Set<string>()
  const body = node.childForFieldName("body")
  if (body !== null) {
    for (const descendant of walkDescendants(body)) {
      if (descendant.type !== "throw_statement") continue
      const thrown = extractThrownType(descendant)
      if (thrown !== null) seen.add(thrown)
    }
  }
  if (jsDocText !== null) {
    for (const tag of extractJsDocThrows(jsDocText)) seen.add(tag)
  }
  return [...seen].sort(compareCodeUnit)
}

/**
 * The type a `throw` names, as far as the tree says: the constructor of `throw new Foo()`;
 * the identifier of `throw err`, which is likely a caught variable and is kept verbatim so at
 * least the local name shows up; the callee of `throw makeError()` / `throw errors.notFound()`
 * so factory-style construction is not silently dropped. Anything else is null — consumers
 * wanting stronger typing rely on JSDoc `@throws`.
 */
function extractThrownType(throwNode: Node): string | null {
  const thrown = thrownValue(throwNode)
  if (thrown === null) return null
  if (thrown.viaNew) return thrown.node.text
  if (thrown.node.type === "identifier") return thrown.node.text
  if (thrown.node.type === "call_expression") {
    return thrown.node.childForFieldName("function")?.text ?? null
  }
  return null
}

/**
 * One `@throws` / `@throw` / `@exception` tag: an optional `{…}`, which must open and close on the
 * tag's own line, and then the tag's text, which runs to the next tag — one opening a line, or one
 * written later on the same line after a blank — or to the end of its comment. The string read
 * here can be several blocks joined (`readLeadingJsDoc`), and neither part reads into the next
 * block or into a tag on a later line: the braces end at their line, and the text at a tag or at
 * the end of the comment.
 *
 * A run of `*`s is taken whole, and ends the text when a `/` follows it, since a comment can close
 * on `**` as well as on one `*`. Asking at each `*` of a run whether a `/` ends it would cost the
 * square of the run's length, and so would two `[ \t]*`s either side of the gutter's optional `*`,
 * which split one run of blanks every way; hence `[ \t]*(?:\*[ \t]*)?`.
 */
const JSDOC_THROWS_PATTERN =
  /@(?:throws?|exception)(?![\w$])[ \t]*(?:\{([^}\n]+)\})?((?:\*+(?![*/])|(?!\n[ \t]*(?:\*[ \t]*)?@|[ \t]@[a-zA-Z])[^*])*)/g

/**
 * The inside of a `{…}` that is a TSDoc link — `@link X`, `@linkcode X`, `@linkplain X`, with or
 * without a `| label` or label text — and its target.
 */
const INLINE_LINK_PATTERN = /^@link(?:code|plain)?\s+([^\s|]+)/

/** A link target that names a declaration: an identifier or dotted path, which a URL is not. */
const DECLARATION_PATH_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

/**
 * An identifier or dotted path starting with an upper-case letter: `E`, `NotFound`,
 * `Errors.NotFound`. Only the first segment is held to upper case (`Errors.notFound` is one), so a
 * bare `errors.Gone` records nothing where `{errors.Gone}` records it, a trailing `.`
 * (`PaymentDeclined.`) records nothing, and `[A-Z]` and `\w` are ASCII-only.
 */
const BARE_TYPE_PATTERN = /^[A-Z][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

/**
 * The exception types declared by the `@throws` tags in the JSDoc text above a declaration, which
 * is several blocks joined when several were written.
 *
 * - A tag with braces records the text in its braces, verbatim and unchecked; the braces must be on
 *   the tag's own line. `@throws {A}{B}` records `A` only. The one exception is a `{…}` opening
 *   with `@`, which holds an inline tag rather than a type: a TSDoc link, `{@link X}` or its
 *   `linkcode` / `linkplain` spelling, records `X` when `X` is an identifier or dotted path, and
 *   anything else (`{@link}`, a URL, `{@inheritDoc}`) records nothing.
 * - With no braces, the tag is `@throws Type` or `@throws free-text description`, and the two
 *   cannot be told apart by syntax. A word is recorded only when it is the tag's whole text and
 *   reads as a type name (`BARE_TYPE_PATTERN`). Anything else — `@throws If the id is unknown.` —
 *   is prose and records nothing: a reworded description must not move the `api` axis.
 */
function extractJsDocThrows(jsDoc: string): string[] {
  const out: string[] = []
  for (const match of jsDoc.matchAll(JSDOC_THROWS_PATTERN)) {
    const braced = match[1]?.trim()
    if (braced !== undefined) {
      const typed = braced.startsWith("@") ? linkTarget(braced) : braced
      if (typed !== null && typed.length > 0) out.push(typed)
      continue
    }
    const text = tagText(match[2] ?? "")
    if (BARE_TYPE_PATTERN.test(text)) out.push(text)
  }
  return out
}

/** The target of a TSDoc link, or null for a link with none, a URL, or another inline tag. */
function linkTarget(inline: string): string | null {
  const target = INLINE_LINK_PATTERN.exec(inline)?.[1]
  return target !== undefined && DECLARATION_PATH_PATTERN.test(target) ? target : null
}

/** A tag's text without the comment's gutter — one leading `*` per line — whitespace-collapsed. */
function tagText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}
