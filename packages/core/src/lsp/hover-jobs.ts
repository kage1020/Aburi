import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { makeCallSiteKey } from "../call-site"
import { symbolIdParts, trySymbolId } from "../id"
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
  const ownerClass =
    ownerClassName === null ? null : findOwnerClass(caller, ownerClassName, job.method, workingById)
  if (ownerClass === null) {
    countProducerRejection(stats, "ownerClassNotFound")
    return
  }
  const memberId = findMemberSymbolId(caller, ownerClass, job.method, workingById)
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

// A hover names the class without its file, so a name several files declare is declined, not
// guessed. A dropped class holding the member can still be meant: a framework hint keeps methods.
function findOwnerClass(
  caller: IRSymbol,
  className: string,
  methodName: string,
  workingById: Map<SymbolId, IRSymbol>,
): IRSymbol | null {
  const callerId = symbolIdParts(caller.id)
  const ownId = callerId === null ? null : trySymbolId({ ...callerId, qualifiedName: className })
  const own = ownId === null ? undefined : workingById.get(ownId)
  if (own?.kind === "class") return own
  const named: IRSymbol[] = []
  for (const symbol of workingById.values()) {
    if (
      symbol.language === caller.language &&
      symbol.name === className &&
      symbol.kind === "class"
    ) {
      named.push(symbol)
    }
  }
  if (named.length === 1) return named[0] ?? null
  const owners = named.filter(
    (symbol) =>
      symbol.dropped !== true ||
      findMemberSymbolId(caller, symbol, methodName, workingById) !== null,
  )
  return owners.length === 1 ? (owners[0] ?? null) : null
}

// Built from the class's id, as nothing binds `name` or `source.file` to it. A hover reads
// `Class.m` for either kind, and the other kind is never what a member's `this.m` reaches.
function findMemberSymbolId(
  caller: IRSymbol,
  ownerClass: IRSymbol,
  methodName: string,
  workingById: Map<SymbolId, IRSymbol>,
): SymbolId | null {
  const owner = symbolIdParts(ownerClass.id)
  if (owner === null) return null
  const found = memberSeparators(caller).flatMap((separator) => {
    const id = trySymbolId({
      ...owner,
      qualifiedName: `${owner.qualifiedName}${separator}${methodName}`,
    })
    return id !== null && workingById.has(id) ? [id] : []
  })
  return found.length === 1 ? (found[0] ?? null) : null
}

// A class's own calls come from static blocks, computed members and field initializers of either
// kind, so its `this` may be either side.
function memberSeparators(caller: IRSymbol): readonly string[] {
  if (caller.kind === "class") return [".", "::"]
  const qualifiedName = symbolIdParts(caller.id)?.qualifiedName ?? ""
  return qualifiedName.lastIndexOf("::") > qualifiedName.lastIndexOf(".") ? ["::"] : ["."]
}
