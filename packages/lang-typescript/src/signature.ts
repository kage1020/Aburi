import { compareCodeUnit } from "@aburi/core"
import type { Signature } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, thrownValue, walkDescendants } from "./ast-helpers"

/**
 * Build a Signature for a function-like declaration node (function_declaration,
 * method_definition, arrow_function, function_expression, etc.).
 *
 * Rules that mirror lang-plugin.md / fingerprint.md:
 * - `inputs[].name` is the binding as written: an identifier, `this`, or the source text of a
 *   destructuring pattern. A rest parameter's `...` is not part of it (`readParameter`).
 * - `inputs[].optional` / `inputs[].rest` record what a caller sees of the parameter's form,
 *   and are written only when true (LP11b).
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
 * runs reaches the logic axis.
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
  return input
}

/** The node's source text, or null where the source wrote no binding there. */
function writtenText(node: Node | null): string | null {
  if (node === null || node.isMissing || node.type === "ERROR") return null
  return node.text
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

const JSDOC_THROWS_PATTERN = /@(?:throws?|exception)\s+(?:\{([^}]+)\}\s*)?(\S*)/g

function extractJsDocThrows(jsDoc: string): string[] {
  const out: string[] = []
  const matches = jsDoc.matchAll(JSDOC_THROWS_PATTERN)
  for (const match of matches) {
    const typed = match[1]?.trim()
    const bare = match[2]?.trim()
    if (typed !== undefined && typed.length > 0) out.push(typed)
    else if (bare !== undefined && bare.length > 0 && !bare.startsWith("*")) out.push(bare)
  }
  return out
}
