import { pathToFileURL } from "node:url"
import type {
  Symbol as IRSymbol,
  LanguageId,
  Logger,
  LspServerConfig,
  SymbolId,
} from "@aburi/types"
import { groupBy } from "../collections"
import { compareCodeUnit } from "../order"
import {
  errorMessage,
  failureReason,
  isLspFailure,
  type LspClient,
  type LspFailure,
} from "./client"
import { applyDocumentSymbols } from "./document-symbols"
import type { ReadFile, ReceiverHint } from "./enrich"
import type { FallbackState } from "./fallback"
import { applyHover, buildHoverJobs, type Hover, requestJobHover } from "./hover-jobs"
import { requestDocumentSymbols } from "./requests"
import type { LspStatsBuilder } from "./stats"

export interface LanguageFilesInput {
  language: LanguageId
  serverConfig: LspServerConfig
  client: LspClient
  symbols: readonly IRSymbol[]
  workingById: Map<SymbolId, IRSymbol>
  fileContents: ReadonlyMap<string, ReadFile>
  workspaceRoot: string
  stats: LspStatsBuilder
  fallback: FallbackState
  receiverHints: Map<string, ReceiverHint>
  logger: Logger
  now: () => number
}

export async function enrichLanguageFiles(input: LanguageFilesInput): Promise<void> {
  const { client, fallback, logger, stats } = input
  const symbolsByFile = groupBy(input.symbols, (symbol) => symbol.source.file)
  const requestTimeout = input.serverConfig.requestTimeoutMs ?? 500
  const fileBudget = input.serverConfig.fileBudgetMs ?? 2000
  const concurrency = input.serverConfig.concurrency ?? 8

  for (const file of [...symbolsByFile.keys()].sort(compareCodeUnit)) {
    const read = input.fileContents.get(file)
    if (read === undefined) continue
    const fileSymbols = symbolsByFile.get(file) ?? []
    const uri = pathToFileURL(joinRoot(input.workspaceRoot, read.fsPath)).toString()
    const fileStart = input.now()
    let fileFellBack = false
    const outOfBudget = (): boolean => input.now() - fileStart > fileBudget
    const settle = <T>(result: T | LspFailure): result is T => {
      const failure = isLspFailure(result) ? result : null
      if (failure?.kind === "timeout") stats.requestsTimedOut += 1
      else if (failure !== null) stats.requestsFailed += 1
      if (fallback.onRequest(file, failure === null).escalate) fileFellBack = true
      return failure === null
    }

    try {
      const opened = await client.didOpen(
        uri,
        lspLanguageId(input.language),
        read.content,
        fileBudget,
      )
      if (isLspFailure(opened)) {
        logger.warn?.(`[aburi:lsp] didOpen failed for ${file} (${failureReason(opened)})`)
        fileFellBack = true
      }
    } catch (error) {
      logger.warn?.(`[aburi:lsp] didOpen failed for ${file}: ${errorMessage(error)}`)
      fileFellBack = true
    }

    if (!fileFellBack && outOfBudget()) fileFellBack = true

    if (!fileFellBack) {
      stats.requestsIssued += 1
      const docSymbols = await requestDocumentSymbols(client, uri, requestTimeout)
      if (settle(docSymbols)) applyDocumentSymbols(docSymbols, fileSymbols, input.workingById)
    }

    if (!fileFellBack && outOfBudget()) fileFellBack = true

    if (!fileFellBack) {
      const jobs = buildHoverJobs(fileSymbols, read.content)
      const hovers = new Map<number, Hover>()
      try {
        await runJobsWithConcurrency(jobs, concurrency, async (job, index) => {
          if (fileFellBack) return
          if (outOfBudget()) {
            fileFellBack = true
            return
          }
          stats.requestsIssued += 1
          const hover = await requestJobHover(job, client, uri, requestTimeout)
          if (settle(hover)) hovers.set(index, hover)
        })
      } finally {
        // Applied in job order after every worker has stopped, so the server's pace cannot reorder writes.
        for (const [index, job] of jobs.entries()) {
          const hover = hovers.get(index)
          if (hover === undefined) continue
          try {
            applyHover(job, hover, input.receiverHints, input.workingById, stats)
          } catch (error) {
            logger.debug?.(
              `[aburi:lsp] applying hover for ${file}:${job.callLine} threw: ${errorMessage(error)}`,
            )
          }
        }
      }
    }

    try {
      const closed = await client.didClose(uri, requestTimeout)
      if (isLspFailure(closed)) {
        logger.debug?.(`[aburi:lsp] didClose failed for ${file} (${failureReason(closed)})`)
      }
    } catch (error) {
      logger.debug?.(`[aburi:lsp] didClose failed for ${file}: ${errorMessage(error)}`)
    }

    if (fileFellBack) stats.filesFellBack += 1
    else stats.filesEnriched += 1
    if (fallback.onFileClose(file, input.language, fileFellBack).escalate) {
      stats.languagesDisabled.add(input.language)
      logger.warn?.(
        `[aburi:lsp] disabling LSP for ${input.language} after 5 consecutive file fallbacks`,
      )
      return
    }
  }
}

async function runJobsWithConcurrency<T>(
  jobs: readonly T[],
  concurrency: number,
  run: (job: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = [...jobs.entries()]
  const failures = new Map<number, unknown>()
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [index, job] = next
      try {
        await run(job, index)
      } catch (error) {
        failures.set(index, error)
      }
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), jobs.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()))
}

function joinRoot(workspaceRoot: string, fsPath: string): string {
  const trimmedRoot =
    workspaceRoot.endsWith("/") || workspaceRoot.endsWith("\\")
      ? workspaceRoot.slice(0, -1)
      : workspaceRoot
  return `${trimmedRoot}/${fsPath}`
}

function lspLanguageId(languageId: LanguageId): string {
  switch (languageId) {
    case "ts":
      return "typescript"
    case "tsx":
      return "typescriptreact"
    case "js":
      return "javascript"
    case "jsx":
      return "javascriptreact"
    default:
      return languageId
  }
}
