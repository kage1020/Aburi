import type { Signature } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, isPresent, walkDescendants } from "./ast-helpers"

/**
 * Build a Signature for a function-like declaration node (function_declaration,
 * method_definition, arrow_function, function_expression, etc.).
 *
 * Rules that mirror lang-plugin.md §4.3 / fingerprint.md §3.1:
 * - `inputs[].name` is the parameter binding name (destructured / rest / this variants
 *   collapse to a printable form).
 * - `inputs[].type` and `outputs[]` are the AST-visible type text; we do not resolve
 *   types.
 * - `throws[]` is the union of explicit `throw new X()` statements inside the body plus
 *   `@throws` tags in the JSDoc block preceding the declaration.
 * - `typeParameters[]` carries the raw text of each type parameter (`T`, `T extends X`, …).
 */
export function buildSignature(
  declaration: Node,
  jsDocText: string | null,
  source: string,
): Signature {
  const async = detectAsync(declaration)
  const generator = detectGenerator(declaration)
  const typeParameters = readTypeParameters(declaration)
  const inputs = readParameters(declaration)
  const outputs = readReturnType(declaration)
  const throws = readThrows(declaration, jsDocText, source)
  return { async, generator, inputs, outputs, throws, typeParameters }
}

function detectAsync(node: Node): boolean {
  for (const child of node.children) {
    if (child !== null && child.type === "async") return true
  }
  // arrow_function's `async` keyword may live as a sibling token; the grammar tags the
  // node itself with an `async` child when present, so a single pass is enough.
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

function readParameters(node: Node): Array<{ name: string; type: string }> {
  const params = node.childForFieldName("parameters") ?? findChild(node, "formal_parameters")
  if (params === null) return []
  const out: Array<{ name: string; type: string }> = []
  for (const child of params.namedChildren) {
    if (child === null) continue
    if (
      child.type === "required_parameter" ||
      child.type === "optional_parameter" ||
      child.type === "rest_pattern"
    ) {
      const name = extractParamName(child)
      const type = extractParamType(child)
      out.push({ name, type })
    }
  }
  return out
}

function extractParamName(param: Node): string {
  const pattern = param.childForFieldName("pattern") ?? param.namedChild(0)
  if (pattern === null) return ""
  if (pattern.type === "identifier") return pattern.text
  // Destructuring / rest patterns: keep the raw text as the "name". The api fingerprint
  // discards the name field anyway, and downstream renderers surface the raw form as-is.
  return pattern.text
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

function readThrows(node: Node, jsDocText: string | null, _source: string): string[] {
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
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function extractThrownType(throwNode: Node): string | null {
  // `throw new Foo(...)` or `throw someExpr` — dig into the argument.
  const argument = throwNode.namedChild(0)
  if (argument === null) return null
  if (argument.type === "new_expression") {
    const ctor = argument.childForFieldName("constructor")
    if (isPresent(ctor)) return ctor.text
  }
  if (argument.type === "identifier") return argument.text
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
