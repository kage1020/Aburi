import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { makeCallSiteKey } from "../call-site"
import { trySymbolId } from "../id"
import { compareCodeUnit } from "../order"
import type { LspClient, LspFailure } from "./client"
import type { ReceiverHint } from "./enrich"
import { extractInferredThrowsFromHover, extractOwnerClassName } from "./hover-text"
import { findMethodColumn, maskStringsAndComments } from "./method-column"
import { requestHover } from "./requests"
import { countProducerRejection, type LspStatsBuilder } from "./stats"

export interface HoverJob {
  symbolId: SymbolId
  callLine: number
  column: number
  target: string
  method: string
  receiverKind: "this" | "super"
}

export type Hover = { text: string } | null

export function buildHoverJobs(fileSymbols: readonly IRSymbol[], content: string): HoverJob[] {
  const jobs: HoverJob[] = []
  const lines = content.split(/\r?\n/)
  const maskedLines = new Map<number, string>()
  for (const symbol of fileSymbols) {
    for (const call of symbol.calls) {
      if (call.resolved !== null) continue
      const line = lines[call.line - 1]
      const [head, method, ...rest] = call.target.split(".").filter((s) => s.length > 0)
      if (line === undefined || method === undefined || rest.length > 0) continue
      if (head !== "this" && head !== "super") continue
      let masked = maskedLines.get(call.line)
      if (masked === undefined) {
        masked = maskStringsAndComments(line)
        maskedLines.set(call.line, masked)
      }
      const column = findMethodColumn(line, masked, head, method)
      if (column === null) continue
      jobs.push({
        symbolId: symbol.id,
        callLine: call.line,
        column,
        target: call.target,
        method,
        receiverKind: head,
      })
    }
  }
  return jobs.sort(
    (a, b) =>
      compareCodeUnit(a.symbolId, b.symbolId) ||
      a.callLine - b.callLine ||
      compareCodeUnit(a.target, b.target),
  )
}

export function requestJobHover(
  job: HoverJob,
  client: LspClient,
  uri: string,
  timeoutMs: number,
): Promise<Hover | LspFailure> {
  return requestHover(client, uri, { line: job.callLine - 1, character: job.column }, timeoutMs)
}

export function applyHover(
  job: HoverJob,
  hover: Hover,
  receiverHints: Map<string, ReceiverHint>,
  workingById: Map<SymbolId, IRSymbol>,
  stats: LspStatsBuilder,
): void {
  const caller = workingById.get(job.symbolId)
  if (caller === undefined) return
  if (hover === null) {
    countProducerRejection(stats, "unparseableHover")
    return
  }
  const ownerClassName = extractOwnerClassName(hover.text)
  const isClass = (symbol: IRSymbol): boolean => symbol.kind === "class"
  if (
    ownerClassName === null ||
    findSymbolId(caller, ownerClassName, workingById, isClass) === null
  ) {
    countProducerRejection(stats, "ownerClassNotFound")
    return
  }
  const memberId = findSymbolId(caller, `${ownerClassName}.${job.method}`, workingById)
  if (memberId === null) {
    countProducerRejection(stats, "memberNotFound")
    return
  }
  stats.hintsProduced += 1
  const key = makeCallSiteKey(caller.source.file, job.callLine, job.target)
  if (!receiverHints.has(key)) {
    receiverHints.set(key, { kind: job.receiverKind, targetSymbolId: memberId })
  }
  const throws = extractInferredThrowsFromHover(hover.text)
  if (throws.length > 0 && caller.signature != null) {
    const merged = new Set([...(caller.signature.inferredThrows ?? []), ...throws])
    caller.signature = { ...caller.signature, inferredThrows: [...merged].sort(compareCodeUnit) }
  }
}

function findSymbolId(
  caller: IRSymbol,
  qualifiedName: string,
  workingById: Map<SymbolId, IRSymbol>,
  accept: (symbol: IRSymbol) => boolean = () => true,
): SymbolId | null {
  const sameFile = trySymbolId({
    language: caller.language,
    file: caller.source.file,
    qualifiedName,
  })
  if (sameFile !== null && workingById.has(sameFile)) return sameFile
  for (const symbol of workingById.values()) {
    if (symbol.language === caller.language && symbol.name === qualifiedName && accept(symbol)) {
      return symbol.id
    }
  }
  return null
}
