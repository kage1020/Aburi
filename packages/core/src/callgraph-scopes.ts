import type { Confidence, ImportEdge, Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { componentKeyOf, type SymbolTable } from "./callgraph-index"
import { dirname, isRelativeSpecifier, resolveRelativeSpecifier } from "./callgraph-specifier"
import { DEFAULT_EXPORT_QNAME, trySymbolId } from "./id"
import { DEFAULT_EXPORT_NAME, splitAliasedImportName } from "./import-edge"

export interface ResolutionTrace {
  ambiguousCandidates: Set<SymbolId>
  parameterShadow: boolean
  unnamedReceiver: boolean
}

export function newTrace(): ResolutionTrace {
  return { ambiguousCandidates: new Set(), parameterShadow: false, unnamedReceiver: false }
}

export function collectParameterNames(symbol: IRSymbol): ReadonlySet<string> {
  const inputs = symbol.signature?.inputs
  if (inputs === undefined) return EMPTY_NAME_SET
  const out = new Set<string>()
  for (const input of inputs) {
    out.add(input.name)
    if (input.bindings === undefined) continue
    for (const binding of input.bindings) out.add(binding)
  }
  return out
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set()

export interface ResolutionHit {
  id: SymbolId
  confidence: Confidence
}

export interface ResolutionRun {
  table: SymbolTable
  extensions: readonly string[]
  relativeTargets: Map<string, string | null>
}

export interface ResolveTargetContext {
  run: ResolutionRun
  caller: IRSymbol
  target: string
  imports: readonly ImportEdge[]
  parameterNames: ReadonlySet<string>
}

export function resolveTarget(
  ctx: ResolveTargetContext,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const [head, ...tail] = splitTargetSegments(ctx.target)
  if (head === undefined) {
    trace.unnamedReceiver = true
    return null
  }

  if (ctx.parameterNames.has(head)) {
    trace.parameterShadow = true
    return null
  }

  if (head === "this" || head === "super") {
    trace.unnamedReceiver = true
    return null
  }

  return (
    resolveInFileScope(ctx, head, tail, trace) ??
    resolveInImportScope(ctx, head, tail, trace) ??
    (tail.length === 0
      ? null
      : (resolveInComponentScope(ctx, trace) ?? resolveInWorkspaceScope(ctx, trace)))
  )
}

function resolveInFileScope(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
  trace: ResolutionTrace,
): ResolutionHit | null {
  const file = ctx.caller.source.file
  const anchor = soleCandidate(ctx.run.table.topLevelByFile.get(file)?.get(head), trace)
  if (anchor === null) return null
  const id = tail.length === 0 ? anchor.id : memberId(ctx, file, head, tail)
  return id === null ? null : { id, confidence: "high" }
}

function memberId(
  ctx: ResolveTargetContext,
  file: string,
  first: string,
  tail: readonly string[],
): SymbolId | null {
  const keptId = (qualifiedName: string) => {
    const id = trySymbolId({ language: ctx.caller.language, file, qualifiedName })
    return id !== null && ctx.run.table.keptSymbolIds.has(id) ? id : null
  }
  let qualifiedName = first
  for (const segment of tail) {
    const staticName = `${qualifiedName}::${segment}`
    qualifiedName = keptId(staticName) === null ? `${qualifiedName}.${segment}` : staticName
  }
  return keptId(qualifiedName)
}

function resolveInImportScope(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
  trace: ResolutionTrace,
): ResolutionHit | null {
  const candidates = new Set<SymbolId>()
  const consider = (file: string, first: string, rest: readonly string[]) => {
    const id = memberId(ctx, file, first, rest)
    if (id !== null) candidates.add(id)
  }
  for (const edge of ctx.imports) {
    if (edge.dynamic || !isRelativeSpecifier(edge.source)) continue
    const targetFile = resolveRelativeSpecifierOnce(ctx, edge.source)
    if (targetFile === null) continue

    if (edge.symbols === "*") {
      const [first, ...rest] = tail
      if (first !== undefined && edge.namespaceBinding === head) consider(targetFile, first, rest)
      continue
    }

    for (const raw of edge.symbols) {
      const { imported, local } = splitAliasedImportName(raw)
      if (local !== head) continue
      if (imported !== DEFAULT_EXPORT_NAME) consider(targetFile, imported, tail)
      else for (const name of defaultExportsOf(ctx, targetFile)) consider(targetFile, name, tail)
    }
  }
  const [only, ...others] = candidates
  if (only === undefined) return null
  if (others.length > 0) {
    for (const id of candidates) trace.ambiguousCandidates.add(id)
    return null
  }
  return { id: only, confidence: "high" }
}

function defaultExportsOf(ctx: ResolveTargetContext, file: string): string[] {
  const found: string[] = []
  for (const bucket of ctx.run.table.topLevelByFile.get(file)?.values() ?? []) {
    for (const symbol of bucket) {
      if (symbol.name === DEFAULT_EXPORT_QNAME || symbol.derivedBy.includes("export-default")) {
        found.push(symbol.name)
      }
    }
  }
  return found
}

function resolveRelativeSpecifierOnce(ctx: ResolveTargetContext, specifier: string): string | null {
  const language = ctx.caller.language
  const fromDirectory = dirname(ctx.caller.source.file)
  // Neither a language id nor a path holds NUL and the specifier comes last: the key splits one way.
  const key = `${language}\0${fromDirectory}\0${specifier}`
  const cached = ctx.run.relativeTargets.get(key)
  if (cached !== undefined) return cached
  const knownFiles = ctx.run.table.filesByLanguage.get(language)
  const resolved =
    knownFiles === undefined
      ? null
      : resolveRelativeSpecifier({
          fromDirectory,
          specifier,
          extensions: ctx.run.extensions,
          knownFiles,
        })
  ctx.run.relativeTargets.set(key, resolved)
  return resolved
}

function resolveInComponentScope(
  ctx: ResolveTargetContext,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const perComponent = ctx.run.table.byComponent
    .get(ctx.caller.language)
    ?.get(componentKeyOf(ctx.caller.component))
  const hit = soleCandidate(perComponent?.get(ctx.target), trace)
  return hit === null ? null : { id: hit.id, confidence: "medium" }
}

function resolveInWorkspaceScope(
  ctx: ResolveTargetContext,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const perName = ctx.run.table.byWorkspace.get(ctx.caller.language)
  const hit = soleCandidate(perName?.get(ctx.target), trace)
  return hit === null ? null : { id: hit.id, confidence: "low" }
}

function soleCandidate(
  bucket: readonly IRSymbol[] | undefined,
  trace: ResolutionTrace,
): IRSymbol | null {
  if (bucket === undefined) return null
  if (bucket.length !== 1) {
    for (const symbol of bucket) trace.ambiguousCandidates.add(symbol.id)
    return null
  }
  return bucket[0] ?? null
}

export function splitTargetSegments(target: string): string[] {
  return target.split(".").filter((s) => s.length > 0)
}
