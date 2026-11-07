import type {
  CallCandidate,
  ImportEdge,
  OpaqueAstNode,
  Reexport,
  SymbolCandidate,
} from "@aburi/types"
import { toNfc } from "../codepoints"
import { toDocumentPath } from "../id"

export function normalizeCandidateStrings(
  candidate: SymbolCandidate<OpaqueAstNode>,
): SymbolCandidate<OpaqueAstNode> {
  const file = toDocumentPath(candidate.source.file, "SymbolCandidate.source.file")
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

function mapPreservingIdentity<L extends readonly unknown[]>(
  items: L,
  transform: (item: L[number]) => L[number],
): L {
  let changed = false
  const next = items.map((item) => {
    const out = transform(item)
    if (out !== item) changed = true
    return out
  })
  return changed ? (next as unknown as L) : items
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

export function normalizeImportEdge(written: Omit<ImportEdge, "origins">): ImportEdge {
  const source = toNfc(written.source)
  const binding = written.namespaceBinding
  const namespaceBinding = typeof binding === "string" ? toNfc(binding) : binding
  const symbols =
    written.symbols === "*" ? written.symbols : mapPreservingIdentity(written.symbols, toNfc)
  const reexports =
    written.reexports === undefined
      ? undefined
      : mapPreservingIdentity(written.reexports, normalizeReexport)
  if (
    !("origins" in written) &&
    source === written.source &&
    namespaceBinding === binding &&
    symbols === written.symbols &&
    reexports === written.reexports
  ) {
    return written
  }
  const next: ImportEdge = { source, symbols, line: written.line, dynamic: written.dynamic }
  if (namespaceBinding !== undefined) next.namespaceBinding = namespaceBinding
  if (reexports !== undefined) next.reexports = reexports
  return next
}

function normalizeReexport(reexport: Reexport): Reexport {
  const imported = toNfc(reexport.imported)
  const exported = toNfc(reexport.exported)
  return imported === reexport.imported && exported === reexport.exported
    ? reexport
    : { imported, exported }
}

export function normalizeCallStrings(call: CallCandidate): CallCandidate {
  const target = toNfc(call.target)
  const written = call.receiverType
  const receiverType = typeof written === "string" ? toNfc(written) : written
  if (target === call.target && receiverType === written) return call
  const next: CallCandidate = { ...call, target }
  if (receiverType !== undefined) next.receiverType = receiverType
  return next
}
