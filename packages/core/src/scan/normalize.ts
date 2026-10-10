import type { CallCandidate, ImportEdge, OpaqueAstNode, SymbolCandidate } from "@aburi/types"
import { toNfc } from "../codepoints"

export function normalizeCandidateStrings(
  candidate: SymbolCandidate<OpaqueAstNode>,
): SymbolCandidate<OpaqueAstNode> {
  const file = toNfc(candidate.source.file)
  const signature = normalizeSignatureStrings(candidate.signature)
  const decorators = normalizeDecoratorNames(candidate.decorators)
  if (
    file === candidate.source.file &&
    signature === candidate.signature &&
    decorators === candidate.decorators
  ) {
    return candidate
  }
  return { ...candidate, source: { ...candidate.source, file }, signature, decorators }
}

function mapPreservingIdentity<T>(items: T[], transform: (item: T) => T): T[] {
  let changed = false
  const next = items.map((item) => {
    const out = transform(item)
    if (out !== item) changed = true
    return out
  })
  return changed ? next : items
}

function normalizeDecoratorNames(
  decorators: SymbolCandidate<OpaqueAstNode>["decorators"],
): SymbolCandidate<OpaqueAstNode>["decorators"] {
  return mapPreservingIdentity(decorators, (decorator) => {
    const name = toNfc(decorator.name)
    const written = decorator.qualifier
    const qualifier = typeof written === "string" ? toNfc(written) : written
    if (name === decorator.name && qualifier === written) return decorator
    const next = { ...decorator, name }
    if (qualifier !== undefined) next.qualifier = qualifier
    return next
  })
}

function normalizeSignatureStrings<T extends SymbolCandidate<OpaqueAstNode>["signature"]>(
  signature: T,
): T {
  if (signature === null || signature === undefined) return signature
  const inputs = mapPreservingIdentity(signature.inputs, (input) => {
    const name = toNfc(input.name)
    const written = input.bindings
    if (written === undefined) return name === input.name ? input : { ...input, name }
    const bindings = mapPreservingIdentity(written, toNfc)
    return name === input.name && bindings === written ? input : { ...input, name, bindings }
  })
  return inputs === signature.inputs ? signature : ({ ...signature, inputs } as T)
}

export function normalizeImportEdge(edge: ImportEdge): ImportEdge {
  const source = toNfc(edge.source)
  const binding = edge.namespaceBinding
  const namespaceBinding = typeof binding === "string" ? toNfc(binding) : binding
  const symbols = edge.symbols === "*" ? edge.symbols : mapPreservingIdentity(edge.symbols, toNfc)
  if (
    source === edge.source &&
    namespaceBinding === edge.namespaceBinding &&
    symbols === edge.symbols
  ) {
    return edge
  }
  const next: ImportEdge = { ...edge, source, symbols }
  if (namespaceBinding !== undefined) next.namespaceBinding = namespaceBinding
  return next
}

export function normalizeCallStrings(call: CallCandidate): CallCandidate {
  const target = toNfc(call.target)
  return target === call.target ? call : { ...call, target }
}
