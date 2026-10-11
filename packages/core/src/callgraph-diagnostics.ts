import type {
  CallResolutionStats,
  ImportEdge,
  Symbol as IRSymbol,
  UnresolvedCallBucket,
  UnresolvedCallBuckets,
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import { type ResolutionTrace, splitTargetSegments } from "./callgraph-scopes"
import { isRelativeSpecifier } from "./callgraph-specifier"
import { splitAliasedImportName } from "./import-edge"
import { compareCodeUnit } from "./order"

interface ClassifyUnresolvedInput {
  caller: IRSymbol
  target: string
  line: number
  imports: readonly ImportEdge[]
  trace: ResolutionTrace
  dynamicReceiver: boolean
}

export function classifyUnresolved(input: ClassifyUnresolvedInput): UnresolvedCallDiagnostic {
  const base = {
    symbolId: input.caller.id,
    target: input.target,
    line: input.line,
  }
  if (input.trace.parameterShadow) {
    return { ...base, bucket: "local-scope", candidates: [] }
  }
  if (input.dynamicReceiver || input.trace.unnamedReceiver) {
    return { ...base, bucket: "dynamic", candidates: [] }
  }
  if (input.trace.ambiguousCandidates.size > 0) {
    return {
      ...base,
      bucket: "ambiguous",
      candidates: [...input.trace.ambiguousCandidates].sort(compareCodeUnit),
    }
  }
  if (bindsToExternalImport(input.target, input.imports)) {
    return { ...base, bucket: "external", candidates: [] }
  }
  return { ...base, bucket: "no-match", candidates: [] }
}

function bindsToExternalImport(target: string, imports: readonly ImportEdge[]): boolean {
  const [head] = splitTargetSegments(target)
  if (head === undefined) return false
  return imports.some(
    (edge) =>
      !edge.dynamic &&
      !isRelativeSpecifier(edge.source) &&
      (edge.symbols === "*"
        ? edge.namespaceBinding === head
        : edge.symbols.some((raw) => splitAliasedImportName(raw).local === head)),
  )
}

export function buildCallResolutionStats(
  totalCalls: number,
  resolvedCalls: number,
  diagnostics: readonly UnresolvedCallDiagnostic[],
): CallResolutionStats {
  const unresolved: UnresolvedCallBuckets = {
    localScope: 0,
    external: 0,
    dynamic: 0,
    ambiguous: 0,
    noMatch: 0,
  }
  for (const diagnostic of diagnostics) {
    unresolved[BUCKET_TO_STATS_KEY[diagnostic.bucket]]++
  }
  return { totalCalls, resolvedCalls, unresolved }
}

const BUCKET_TO_STATS_KEY: Record<UnresolvedCallBucket, keyof UnresolvedCallBuckets> = {
  "local-scope": "localScope",
  external: "external",
  dynamic: "dynamic",
  ambiguous: "ambiguous",
  "no-match": "noMatch",
}

export function compareDiagnostic(
  a: UnresolvedCallDiagnostic,
  b: UnresolvedCallDiagnostic,
): number {
  return (
    compareCodeUnit(a.symbolId, b.symbolId) ||
    a.line - b.line ||
    compareCodeUnit(a.target, b.target)
  )
}
