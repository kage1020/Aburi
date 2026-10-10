import type {
  CallResolutionStats,
  Confidence,
  ImportEdge,
  IR,
  Symbol as IRSymbol,
  SymbolId,
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import { CALL_SITE_KEY_SEPARATOR, makeCallSiteKey, receiverHead } from "./call-site"
import {
  buildCallResolutionStats,
  classifyUnresolved,
  compareDiagnostic,
} from "./callgraph-diagnostics"
import { buildSymbolTable } from "./callgraph-index"
import {
  collectParameterNames,
  newTrace,
  type ResolutionHit,
  type ResolutionRun,
  resolveTarget,
} from "./callgraph-scopes"
import { DEFAULT_EXTENSIONS } from "./callgraph-specifier"
import { CoreError } from "./errors"
import type { ReceiverHint } from "./lsp/enrich"
import { emptyHintUsage, type LspConsumerRejection, type LspHintUsage } from "./lsp/stats"
import { compareCodeUnit } from "./order"

export interface CallEdge {
  from: SymbolId
  to: SymbolId
  via: "call"
  confidence: Confidence
  line: number
}

export interface ResolveCallGraphInput {
  symbols: readonly IRSymbol[]
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>
  fileExtensions?: readonly string[]
  receiverHints?: ReadonlyMap<string, ReceiverHint>
  implementerHints?: ReadonlyMap<SymbolId, readonly SymbolId[]>
  dynamicCallSites?: ReadonlySet<string>
}

export interface ResolveCallGraphResult {
  symbols: IRSymbol[]
  edges: CallEdge[]
  stats: CallResolutionStats
  diagnostics: UnresolvedCallDiagnostic[]
  lspHintUsage: Readonly<LspHintUsage>
}

export function resolveCallGraph(input: ResolveCallGraphInput): ResolveCallGraphResult {
  const receiverHints = input.receiverHints ?? EMPTY_RECEIVER_HINTS
  assertReceiverHintKeys(receiverHints)
  const dynamicCallSites = input.dynamicCallSites ?? EMPTY_CALL_SITE_KEYS
  const run: ResolutionRun = {
    table: buildSymbolTable(input.symbols),
    extensions: input.fileExtensions ?? DEFAULT_EXTENSIONS,
    relativeTargets: new Map(),
  }

  const nextSymbols: IRSymbol[] = []
  const edges: CallEdge[] = []
  const diagnostics: UnresolvedCallDiagnostic[] = []
  const lspHintUsage = emptyHintUsage()
  let totalCalls = 0
  let resolvedCalls = 0

  for (const symbol of input.symbols) {
    if (symbol.calls.length === 0) {
      nextSymbols.push(symbol)
      continue
    }
    totalCalls += symbol.calls.length
    const imports = input.importsByFile.get(symbol.source.file) ?? []
    const parameterNames = collectParameterNames(symbol)
    const updatedCalls = symbol.calls.map((call) => {
      if (call.resolved !== null) {
        resolvedCalls++
        return call
      }
      const trace = newTrace()
      let hit = resolveTarget(
        { run, caller: symbol, target: call.target, imports, parameterNames },
        trace,
      )
      if (hit === null) {
        const callSiteKey = makeCallSiteKey(symbol.source.file, call.line, call.target)
        const hinted = resolveViaLspHint(
          call.target,
          receiverHints.get(callSiteKey),
          run.table.keptSymbolIds,
        )
        if (hinted.outcome === "rejected") lspHintUsage[hinted.reason] += 1
        if (hinted.outcome !== "hit") {
          diagnostics.push(
            classifyUnresolved({
              caller: symbol,
              target: call.target,
              line: call.line,
              imports,
              trace,
              dynamicReceiver: dynamicCallSites.has(callSiteKey),
            }),
          )
          return call
        }
        lspHintUsage.consumed += 1
        hit = hinted.hit
      }
      resolvedCalls++
      edges.push({
        from: symbol.id,
        to: hit.id,
        via: "call",
        confidence: hit.confidence,
        line: call.line,
      })
      return { target: call.target, line: call.line, resolved: hit.id }
    })
    nextSymbols.push({ ...symbol, calls: updatedCalls })
  }

  edges.sort(compareCallEdge)
  diagnostics.sort(compareDiagnostic)
  return {
    symbols: nextSymbols,
    edges,
    stats: buildCallResolutionStats(totalCalls, resolvedCalls, diagnostics),
    diagnostics,
    lspHintUsage,
  }
}

const EMPTY_CALL_SITE_KEYS: ReadonlySet<string> = new Set()
const EMPTY_RECEIVER_HINTS: ReadonlyMap<string, ReceiverHint> = new Map()

function assertReceiverHintKeys(hints: ReadonlyMap<string, ReceiverHint>): void {
  for (const key of hints.keys()) {
    if (key.includes(CALL_SITE_KEY_SEPARATOR)) continue
    throw new CoreError(
      `resolveCallGraph: receiverHints key ${JSON.stringify(key)} was not built by makeCallSiteKey(file, line, target)`,
      { code: "receiver-hint-key-malformed", value: key },
    )
  }
}

type LspHintOutcome =
  | { outcome: "hit"; hit: ResolutionHit }
  | { outcome: "absent" }
  | { outcome: "rejected"; reason: LspConsumerRejection }

function resolveViaLspHint(
  target: string,
  hint: ReceiverHint | undefined,
  keptSymbolIds: ReadonlySet<SymbolId>,
): LspHintOutcome {
  if (hint === undefined) return { outcome: "absent" }
  if (receiverHead(target) !== hint.kind) return { outcome: "rejected", reason: "kindMismatch" }
  if (!keptSymbolIds.has(hint.targetSymbolId)) {
    return { outcome: "rejected", reason: "targetDropped" }
  }
  return { outcome: "hit", hit: { id: hint.targetSymbolId, confidence: "high" } }
}

export function reconstructCallEdgesFromIR(ir: IR): CallEdge[] {
  const edges: CallEdge[] = []
  for (const symbol of ir.symbols) {
    for (const call of symbol.calls) {
      if (call.resolved === null) continue
      edges.push({
        from: symbol.id,
        to: call.resolved,
        via: "call",
        confidence: symbol.confidence,
        line: call.line,
      })
    }
  }
  return edges.sort(compareCallEdge)
}

function compareCallEdge(a: CallEdge, b: CallEdge): number {
  return compareCodeUnit(a.from, b.from) || compareCodeUnit(a.to, b.to) || a.line - b.line
}
