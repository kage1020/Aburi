import { compareCodeUnit } from "@aburi/core"
import type { Signature } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, thrownValue, walkDescendants } from "./ast-helpers"
import { collectPatternBindings, isRepairedPattern } from "./pattern-bindings"

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
  for (const child of params.namedChildren) {
    if (child === null) continue
    if (child.type === "required_parameter" || child.type === "optional_parameter") {
      out.push(readParameter(child))
    }
  }
  return out
}

function readBareParameter(node: Node): Signature["inputs"] {
  const parameter = node.childForFieldName("parameter")
  if (parameter === null) return []
  const name = parameter.text.trim()
  if (name.length === 0) return []
  return [{ name, type: "" }]
}

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

function writtenText(node: Node | null): string | null {
  if (node === null || node.isMissing || node.type === "ERROR") return null
  return node.text
}

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

const JSDOC_THROWS_PATTERN =
  /@(?:throws?|exception)(?![\w$])[ \t]*(?:\{([^}\n]+)\})?((?:\*+(?![*/])|(?!\n[ \t]*(?:\*[ \t]*)?@|[ \t]@[a-zA-Z])[^*])*)/g

const INLINE_LINK_PATTERN = /^@link(?:code|plain)?\s+([^\s|]+)/

const DECLARATION_PATH_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

const BARE_TYPE_PATTERN = /^[A-Z][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

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

function linkTarget(inline: string): string | null {
  const target = INLINE_LINK_PATTERN.exec(inline)?.[1]
  return target !== undefined && DECLARATION_PATH_PATTERN.test(target) ? target : null
}

function tagText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}
