import {
  type Confidence,
  EXPORT_DEFAULT_DERIVED_BY,
  type ImportEdge,
  type Symbol as IRSymbol,
  type SymbolId,
} from "@aburi/types"
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

  // Component and workspace scope match the whole target by spelling, so past the declaration a
  // head is bound to they could only find a namesake.
  const bound =
    resolveInFileScope(ctx, head, tail, trace) ?? resolveInImportScope(ctx, head, tail, trace)
  if (bound !== null) return bound.hit
  if (tail.length === 0) return null
  return resolveInComponentScope(ctx, trace) ?? resolveInWorkspaceScope(ctx, trace)
}

interface BoundHead {
  hit: ResolutionHit | null
}

const NO_MEMBER: BoundHead = { hit: null }

function resolveInFileScope(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
  trace: ResolutionTrace,
): BoundHead | null {
  const file = ctx.caller.source.file
  const owned = ownsMembers(ctx, file, head)
  const declared = ctx.run.table.topLevelByFile.get(file)?.get(head)
  if (declared !== undefined) {
    const anchor = soleCandidate(declared, trace)
    if (anchor === null) return null
    if (tail.length === 0) return { hit: { id: anchor.id, confidence: "high" } }
  } else if (!owned) {
    return null
  }
  const id = memberId(ctx, file, head, tail)
  if (id !== null) return { hit: { id, confidence: "high" } }
  return owned ? NO_MEMBER : null
}

function ownsMembers(ctx: ResolveTargetContext, file: string, name: string): boolean {
  return ctx.run.table.memberOwnersByFile.get(file)?.has(name) === true
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
): BoundHead | null {
  const { names, renamed } = importedNamesOf(ctx, head, tail)
  const candidates = new Set<SymbolId>()
  for (const { file, name, rest } of names) {
    const id = memberId(ctx, file, name, rest)
    if (id !== null) candidates.add(id)
  }
  const [only, ...others] = candidates
  if (only !== undefined && others.length === 0) return { hit: { id: only, confidence: "high" } }
  for (const id of candidates) trace.ambiguousCandidates.add(id)
  // Under an alias, or a default or namespace import, the target never spells the declaration's
  // name, so the import binds the head even where the module does not declare it.
  const bound = renamed || names.some(({ file, name }) => ownsMembers(ctx, file, name))
  return bound ? NO_MEMBER : null
}

interface ImportedName {
  file: string
  name: string
  rest: readonly string[]
}

interface ImportedNames {
  names: ImportedName[]
  renamed: boolean
}

function importedNamesOf(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
): ImportedNames {
  const names: ImportedName[] = []
  let renamed = false
  for (const edge of ctx.imports) {
    if (edge.dynamic) continue

    if (edge.symbols === "*") {
      if (edge.namespaceBinding !== head) continue
      renamed = true
      const [first, ...rest] = tail
      const file = relativeTargetOf(ctx, edge)
      if (first !== undefined && file !== null) names.push({ file, name: first, rest })
      continue
    }

    for (const raw of edge.symbols) {
      const { imported, local } = splitAliasedImportName(raw)
      if (local !== head) continue
      if (imported !== local) renamed = true
      const file = relativeTargetOf(ctx, edge)
      if (file === null) continue
      if (imported !== DEFAULT_EXPORT_NAME) names.push({ file, name: imported, rest: tail })
      else for (const name of defaultExportsOf(ctx, file)) names.push({ file, name, rest: tail })
    }
  }
  return { names, renamed }
}

function relativeTargetOf(ctx: ResolveTargetContext, edge: ImportEdge): string | null {
  return isRelativeSpecifier(edge.source) ? resolveRelativeSpecifierOnce(ctx, edge.source) : null
}

function defaultExportsOf(ctx: ResolveTargetContext, file: string): string[] {
  const found: string[] = []
  for (const bucket of ctx.run.table.topLevelByFile.get(file)?.values() ?? []) {
    for (const symbol of bucket) {
      if (
        symbol.name === DEFAULT_EXPORT_QNAME ||
        symbol.derivedBy.includes(EXPORT_DEFAULT_DERIVED_BY)
      ) {
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
