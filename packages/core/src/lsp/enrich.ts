import { pathToFileURL } from "node:url"
import type {
  Config,
  Symbol as IRSymbol,
  LanguageId,
  Logger,
  LspServerConfig,
  SymbolId,
} from "@aburi/types"
import type { DocumentSymbol, Position, SymbolInformation } from "vscode-languageserver-protocol"
import { makeCallSiteKey, receiverHead } from "../call-site"
import { groupBy } from "../collections"
import { lastQnameSegment } from "../fingerprint/short-name"
import { trySymbolId } from "../id"
import { silentLogger } from "../logger"
import { compareBy, compareCodeUnit } from "../order"
import {
  createLspClient,
  errorMessage,
  isLspFailure,
  type LspClient,
  type LspFailure,
  SHUTDOWN_GRACE_MS,
} from "./client"
import { createFallbackState, type FallbackState } from "./fallback"
import { requestDocumentSymbols, requestHover } from "./requests"
import {
  countProducerRejection,
  createStatsBuilder,
  finalizeStats,
  type LspProducerStats,
  type LspStatsBuilder,
} from "./stats"
import { type SpawnedServer, spawnStdioServer } from "./transport"

/** A file the caller read: what was in it, and the name it was read under. */
export interface ReadFile {
  content: string
  /** Relative to `workspaceRoot`, as the filesystem spells it — not as the Document does. */
  fsPath: string
}

export interface EnrichmentInput {
  symbols: readonly IRSymbol[]
  workspaceRoot: string
  fileContents: ReadonlyMap<string, ReadFile>
  lspConfig: Config["lsp"] | undefined
  logger?: Logger
  serverFactory?: ServerFactory
  now?: () => number
}

export interface EnrichmentResult {
  symbols: IRSymbol[]
  receiverHints: ReadonlyMap<string, ReceiverHint>
  implementerHints: ReadonlyMap<SymbolId, readonly SymbolId[]>
  stats: LspProducerStats | undefined
}

export interface ReceiverHint {
  kind: "this" | "super"
  targetSymbolId: SymbolId
}

export type ServerFactory = (
  language: LanguageId,
  serverConfig: LspServerConfig,
  workspaceRoot: string,
) => Promise<LspClient | null> | LspClient | null

const CLIENT_CAPABILITIES = {
  textDocument: {
    hover: { contentFormat: ["plaintext", "markdown"] },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
  },
  workspace: {},
} as const

export async function enrichWithLsp(input: EnrichmentInput): Promise<EnrichmentResult> {
  const emptyResult: EnrichmentResult = {
    symbols: [...input.symbols],
    receiverHints: new Map(),
    implementerHints: new Map(),
    stats: undefined,
  }
  if (input.lspConfig?.enabled !== true) return emptyResult
  const servers = input.lspConfig.servers
  if (servers === undefined) return emptyResult

  const logger: Logger = input.logger ?? silentLogger
  const stats = createStatsBuilder(true)
  const fallback = createFallbackState()

  const symbolsByLanguage = groupBy(input.symbols, (symbol) => symbol.language)
  const workingSymbols: IRSymbol[] = input.symbols.map((s) => cloneSymbol(s))
  const workingById = new Map<SymbolId, IRSymbol>()
  for (const s of workingSymbols) workingById.set(s.id, s)

  const receiverHints = new Map<string, ReceiverHint>()

  const factory = input.serverFactory ?? defaultServerFactory

  for (const [language, langSymbols] of [...symbolsByLanguage].sort(compareBy(([id]) => id))) {
    const serverConfig = servers[language]
    if (serverConfig === undefined) continue

    let client: LspClient | null = null
    try {
      const raw = factory(language, serverConfig, input.workspaceRoot)
      client = raw instanceof Promise ? await raw : raw
    } catch (error) {
      logger.warn?.(`[aburi:lsp] failed to spawn server for ${language}: ${errorMessage(error)}`)
      fallback.onLanguageDisabled(language)
      stats.languagesDisabled.add(language)
      continue
    }
    if (client === null) {
      logger.warn?.(`[aburi:lsp] server not available for ${language}`)
      fallback.onLanguageDisabled(language)
      stats.languagesDisabled.add(language)
      continue
    }

    try {
      const initTimeout = serverConfig.initializeTimeoutMs ?? 10000
      const initResult = await client.initialize({
        workspaceRoot: input.workspaceRoot,
        initializationOptions: serverConfig.initializationOptions ?? {},
        capabilities: CLIENT_CAPABILITIES,
        timeoutMs: initTimeout,
      })
      if (isLspFailure(initResult)) {
        logger.warn?.(
          `[aburi:lsp] initialize failed for ${language} (${failureReason(initResult)}); falling back to untyped tier for this language`,
        )
        fallback.onLanguageDisabled(language)
        stats.languagesDisabled.add(language)
        continue
      }

      await processLanguage({
        language,
        serverConfig,
        client,
        symbols: langSymbols,
        workingById,
        fileContents: input.fileContents,
        workspaceRoot: input.workspaceRoot,
        stats,
        fallback,
        receiverHints,
        logger,
        now: input.now ?? monotonicNow,
      })
    } catch (error) {
      logger.warn?.(
        `[aburi:lsp] enrichment for ${language} threw (${errorMessage(error)}); falling back to untyped tier for this language`,
      )
      logger.debug?.(`[aburi:lsp] enrichment for ${language} threw`, {
        language,
        error: describeErrorClass(error),
        stack: errorStack(error),
      })
      fallback.onLanguageDisabled(language)
      stats.languagesDisabled.add(language)
    } finally {
      await safeShutdown(client, language, logger)
    }
  }

  return {
    symbols: workingSymbols,
    receiverHints,
    // Interface tier deferred (see file header) — always empty for now.
    implementerHints: new Map(),
    stats: finalizeStats(stats),
  }
}

interface ProcessLanguageInput {
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

async function processLanguage(input: ProcessLanguageInput): Promise<void> {
  const symbolsByFile = groupBy(input.symbols, (symbol) => symbol.source.file)
  const filesSorted = [...symbolsByFile.keys()].sort(compareCodeUnit)

  const requestTimeout = input.serverConfig.requestTimeoutMs ?? 500
  const fileBudget = input.serverConfig.fileBudgetMs ?? 2000
  const concurrency = input.serverConfig.concurrency ?? 8

  for (const file of filesSorted) {
    if (input.fallback.isLanguageDisabled(input.language)) break
    const read = input.fileContents.get(file)
    if (read === undefined) continue
    const content = read.content

    const uri = fileUriFor(input.workspaceRoot, read.fsPath)
    const languageIdForOpen = languageIdForLspOpen(input.language)
    const fileSymbols = symbolsByFile.get(file) ?? []

    const fileStart = input.now()
    let fileFellBack = false

    try {
      const opened = await input.client.didOpen(uri, languageIdForOpen, content, fileBudget)
      if (isLspFailure(opened)) {
        input.logger.warn?.(`[aburi:lsp] didOpen failed for ${file} (${failureReason(opened)})`)
        fileFellBack = true
      }
    } catch (error) {
      input.logger.warn?.(`[aburi:lsp] didOpen failed for ${file}: ${errorMessage(error)}`)
      fileFellBack = true
    }

    if (!fileFellBack && overBudget(input.now, fileStart, fileBudget)) fileFellBack = true

    if (!fileFellBack) {
      input.stats.requestsIssued += 1
      const docSymbols = await requestDocumentSymbols(input.client, uri, requestTimeout)
      const requestOk = !isLspFailure(docSymbols)
      if (isLspFailure(docSymbols)) accountForFailure(input.stats, docSymbols)
      const requestOutcome = input.fallback.onRequest(file, requestOk)
      if (requestOutcome.escalate) fileFellBack = true
      if (requestOk) {
        applyDocumentSymbols(
          docSymbols as DocumentSymbol[] | SymbolInformation[],
          fileSymbols,
          input.workingById,
        )
      }
    }

    if (!fileFellBack && overBudget(input.now, fileStart, fileBudget)) fileFellBack = true

    if (!fileFellBack) {
      const jobs = buildRequestJobs(fileSymbols, content)
      const responses: unknown[] = new Array(jobs.length)
      const answered: boolean[] = new Array(jobs.length).fill(false)
      try {
        await runJobsWithConcurrency(jobs, concurrency, async (job, index) => {
          if (fileFellBack) return
          if (overBudget(input.now, fileStart, fileBudget)) {
            fileFellBack = true
            return
          }
          input.stats.requestsIssued += 1
          const result = await executeJob(job, input.client, uri, requestTimeout)
          const jobOk = !isLspFailure(result)
          if (isLspFailure(result)) accountForFailure(input.stats, result)
          const outcome = input.fallback.onRequest(file, jobOk)
          if (outcome.escalate) fileFellBack = true
          if (jobOk) {
            responses[index] = result
            answered[index] = true
          }
        })
      } finally {
        for (let index = 0; index < jobs.length; index += 1) {
          const job = jobs[index]
          if (job === undefined || !answered[index]) continue
          try {
            applyJobResult(
              job,
              responses[index],
              input.receiverHints,
              input.workingById,
              input.stats,
            )
          } catch (error) {
            input.logger.debug?.(
              `[aburi:lsp] applying hover for ${file}:${job.callLine} threw: ${errorMessage(error)}`,
            )
          }
        }
      }
    }

    try {
      const closed = await input.client.didClose(uri, requestTimeout)
      if (isLspFailure(closed)) {
        input.logger.debug?.(`[aburi:lsp] didClose failed for ${file} (${failureReason(closed)})`)
      }
    } catch (error) {
      input.logger.debug?.(`[aburi:lsp] didClose failed for ${file}: ${errorMessage(error)}`)
    }

    if (fileFellBack) {
      input.stats.filesFellBack += 1
    } else {
      input.stats.filesEnriched += 1
    }
    const closeOutcome = input.fallback.onFileClose(file, input.language, fileFellBack)
    if (closeOutcome.escalate) {
      input.fallback.onLanguageDisabled(input.language)
      input.stats.languagesDisabled.add(input.language)
      input.logger.warn?.(
        `[aburi:lsp] disabling LSP for ${input.language} after 5 consecutive file fallbacks`,
      )
      break
    }
  }
}

type RequestJob = {
  kind: "this-super-hover"
  symbolId: SymbolId
  callLine: number
  column: number
  target: string
  calleeText: string
  receiverKind: "this" | "super"
}

function buildRequestJobs(fileSymbols: readonly IRSymbol[], content: string): RequestJob[] {
  const jobs: RequestJob[] = []
  const lines = content.split(/\r?\n/)
  const maskedLines = new Map<number, string>()
  for (const symbol of fileSymbols) {
    for (const call of symbol.calls) {
      if (call.resolved !== null) continue
      const line = lines[call.line - 1]
      if (line === undefined) continue
      const segments = call.target.split(".").filter((s) => s.length > 0)
      if (segments.length !== 2) continue
      const head = receiverHead(call.target)
      const method = segments[1] as string
      if (head !== "this" && head !== "super") continue
      let masked = maskedLines.get(call.line)
      if (masked === undefined) {
        masked = maskStringsAndComments(line)
        maskedLines.set(call.line, masked)
      }
      const column = findMethodColumn(line, masked, head, method)
      if (column === null) continue
      jobs.push({
        kind: "this-super-hover",
        symbolId: symbol.id,
        callLine: call.line,
        column,
        target: call.target,
        calleeText: method,
        receiverKind: head,
      })
    }
  }
  jobs.sort(compareRequestJob)
  return jobs
}

function compareRequestJob(a: RequestJob, b: RequestJob): number {
  return (
    compareCodeUnit(a.symbolId, b.symbolId) ||
    a.callLine - b.callLine ||
    compareCodeUnit(a.target, b.target)
  )
}

async function executeJob(
  job: RequestJob,
  client: LspClient,
  uri: string,
  timeoutMs: number,
): Promise<unknown | LspFailure> {
  const position: Position = { line: job.callLine - 1, character: job.column }
  return await requestHover(client, uri, position, timeoutMs)
}

function applyJobResult(
  job: RequestJob,
  result: unknown,
  receiverHints: Map<string, ReceiverHint>,
  workingById: Map<SymbolId, IRSymbol>,
  stats: LspStatsBuilder,
): void {
  const caller = workingById.get(job.symbolId)
  if (caller === undefined) return
  const text = extractHoverPayload(result)
  if (text === null) {
    countProducerRejection(stats, "unparseableHover")
    return
  }
  const ownerClassName = extractOwnerClassName(text)
  if (ownerClassName === null) {
    countProducerRejection(stats, "ownerClassNotFound")
    return
  }
  const ownerClassId = findClassSymbolId(caller, ownerClassName, workingById)
  if (ownerClassId === null) {
    countProducerRejection(stats, "ownerClassNotFound")
    return
  }
  const memberId = findMemberSymbolId(
    caller.language,
    caller.source.file,
    ownerClassName,
    job.calleeText,
    workingById,
  )
  if (memberId === null) {
    countProducerRejection(stats, "memberNotFound")
    return
  }
  stats.hintsProduced += 1
  const key = makeCallSiteKey(caller.source.file, job.callLine, job.target)
  if (!receiverHints.has(key)) {
    receiverHints.set(key, { kind: job.receiverKind, targetSymbolId: memberId })
  }
  const throws = extractInferredThrowsFromHover(text)
  if (throws.length > 0) appendInferredThrows(caller, throws)
}

function applyDocumentSymbols(
  entries: DocumentSymbol[] | SymbolInformation[],
  fileSymbols: readonly IRSymbol[],
  workingById: Map<SymbolId, IRSymbol>,
): void {
  const flat: Array<{
    name: string
    startLine: number
    startCol: number
    endLine: number
    endCol: number
  }> = []
  const push = (name: string, range: { start: Position; end: Position }): void => {
    flat.push({
      name,
      startLine: range.start.line + 1,
      startCol: range.start.character + 1,
      endLine: range.end.line + 1,
      endCol: range.end.character + 1,
    })
  }
  const stack: (DocumentSymbol | SymbolInformation)[] = [...entries].reverse()
  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined) continue
    if ("range" in entry) {
      push(entry.name, entry.range)
      const children = (entry as DocumentSymbol).children
      if (Array.isArray(children)) {
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i]
          if (child !== undefined) stack.push(child)
        }
      }
      continue
    }
    const info = entry as SymbolInformation
    if (info.location?.range !== undefined) push(info.name, info.location.range)
  }

  for (const symbol of fileSymbols) {
    const match = flat.find(
      (e) => e.startLine === symbol.source.startLine && lastSegment(symbol.name) === e.name,
    )
    if (match === undefined) continue
    const working = workingById.get(symbol.id)
    if (working === undefined) continue
    working.source = {
      ...working.source,
      startColumn: match.startCol,
      endColumn: match.endCol,
    }
  }
}

function appendInferredThrows(symbol: IRSymbol, throws: readonly string[]): void {
  if (symbol.signature === null || symbol.signature === undefined) return
  const existing = symbol.signature.inferredThrows ?? []
  const merged = [...new Set([...existing, ...throws])].sort(compareCodeUnit)
  if (merged.length === 0) return
  symbol.signature = { ...symbol.signature, inferredThrows: merged }
}

async function runJobsWithConcurrency<T>(
  jobs: readonly T[],
  concurrency: number,
  run: (job: T, index: number) => Promise<void>,
): Promise<void> {
  if (jobs.length === 0) return
  const workers = Math.max(1, Math.min(concurrency, jobs.length))
  let cursor = 0
  const failures = new Map<number, unknown>()
  const takers = Array.from({ length: workers }, async () => {
    while (cursor < jobs.length) {
      const idx = cursor
      cursor += 1
      const job = jobs[idx]
      if (job === undefined) return
      try {
        await run(job, idx)
      } catch (error) {
        failures.set(idx, error)
      }
    }
  })
  await Promise.all(takers)
  if (failures.size === 0) return
  const first = Math.min(...failures.keys())
  throw failures.get(first)
}

function cloneSymbol(symbol: IRSymbol): IRSymbol {
  const cloned: IRSymbol = {
    ...symbol,
    source: { ...symbol.source },
    component: symbol.component ?? null,
    signature: symbol.signature == null ? null : cloneSignature(symbol.signature),
    calls: symbol.calls.map((c) => ({ ...c })),
    decorators: symbol.decorators.map((d) => ({ ...d })),
    rules: symbol.rules.map((r) => ({ ...r })),
    effects: symbol.effects.map((e) => ({ ...e })),
    fingerprint: { ...symbol.fingerprint },
  }
  return cloned
}

function cloneSignature(
  signature: NonNullable<IRSymbol["signature"]>,
): NonNullable<IRSymbol["signature"]> {
  const base = {
    inputs: signature.inputs.map((i) =>
      i.bindings === undefined ? { ...i } : { ...i, bindings: [...i.bindings] },
    ),
    outputs: [...signature.outputs],
    throws: [...signature.throws],
    async: signature.async,
    generator: signature.generator,
    typeParameters: [...signature.typeParameters],
  }
  if (signature.inferredThrows !== undefined) {
    return { ...base, inferredThrows: [...signature.inferredThrows] }
  }
  return base
}

/** `relativePath` is a filesystem path, not a Document one — see `EnrichmentInput.fileContents`. */
function fileUriFor(workspaceRoot: string, relativePath: string): string {
  const absolute = normalizeAbsolute(workspaceRoot, relativePath)
  return pathToFileURL(absolute).toString()
}

function normalizeAbsolute(workspaceRoot: string, relativePath: string): string {
  const trimmedRoot =
    workspaceRoot.endsWith("/") || workspaceRoot.endsWith("\\")
      ? workspaceRoot.slice(0, -1)
      : workspaceRoot
  return `${trimmedRoot}/${relativePath}`
}

function languageIdForLspOpen(languageId: LanguageId): string {
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

function monotonicNow(): number {
  return performance.now()
}

function overBudget(now: () => number, startMs: number, budgetMs: number): boolean {
  return now() - startMs > budgetMs
}

function accountForFailure(stats: LspStatsBuilder, failure: LspFailure): void {
  if (failure.kind === "timeout") stats.requestsTimedOut += 1
  else stats.requestsFailed += 1
}

function failureReason(failure: LspFailure): string {
  if (failure.kind === "timeout") return "timeout"
  return `${failure.reason}: ${failure.message}`
}

function describeErrorClass(error: unknown): string {
  if (error instanceof Error) return error.name
  return typeof error
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined
}

async function safeShutdown(
  client: LspClient,
  language: LanguageId,
  logger: Logger,
): Promise<void> {
  const stranded = (detail: string): void => {
    logger.warn?.(
      `[aburi:lsp] shutting down the ${language} server failed (${detail}); it may still be running`,
    )
  }
  try {
    const answered = await Promise.race([
      client.shutdown().then(() => true),
      delay(SHUTDOWN_CALL_BUDGET_MS).then(() => false),
    ])
    if (!answered) stranded(`no answer in ${SHUTDOWN_CALL_BUDGET_MS}ms`)
  } catch (error) {
    stranded(errorMessage(error))
  }
}

const SHUTDOWN_CALL_BUDGET_MS = SHUTDOWN_GRACE_MS * 3

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}

function findMethodColumn(
  line: string,
  masked: string,
  head: string,
  method: string,
): number | null {
  const needle = new RegExp(
    `${NO_NAME_BEFORE}${escapeRegExp(head)}\\??\\.${escapeRegExp(method)}${NO_NAME_AFTER}`,
    "gu",
  )
  const match = masked.matchAll(needle).next().value ?? soleMatch(line, needle)
  if (match === undefined) return null
  return match.index + match[0].length - method.length
}

const NO_NAME_BEFORE = String.raw`(?<![\p{ID_Continue}$\u{200C}\u{200D}])(?<!(?<!\.\.)\.)`
const NO_NAME_AFTER = String.raw`(?![\p{ID_Continue}$\u{200C}\u{200D}])`

function soleMatch(text: string, pattern: RegExp): RegExpExecArray | undefined {
  const [only, ...rest] = text.matchAll(pattern)
  return rest.length === 0 ? only : undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function maskStringsAndComments(line: string): string {
  const out = line.split("")
  maskCode(line, 0, out, false)
  return out.join("")
}

function maskCode(line: string, start: number, out: string[], inInterpolation: boolean): number {
  let depth = 0
  let i = start
  while (i < line.length) {
    const char = line[i]
    const next = line[i + 1]
    if (char === "/" && next === "/") {
      blank(out, i, line.length)
      return line.length
    }
    if (char === "/" && next === "*") {
      const close = line.indexOf("*/", i + 2)
      const end = close === -1 ? line.length : close + 2
      blank(out, i, end)
      i = end
      continue
    }
    if (char === '"' || char === "'") {
      const end = quotedEnd(line, i, char)
      blank(out, i, end)
      i = end
      continue
    }
    if (char === "`") {
      i = maskTemplate(line, i, out)
      continue
    }
    if (char === "{") depth += 1
    if (char === "}") {
      if (inInterpolation && depth === 0) return i
      depth -= 1
    }
    i += 1
  }
  return line.length
}

function maskTemplate(line: string, start: number, out: string[]): number {
  blank(out, start, start + 1)
  let i = start + 1
  while (i < line.length) {
    const char = line[i]
    if (char === "`") {
      blank(out, i, i + 1)
      return i + 1
    }
    if (char === "$" && line[i + 1] === "{") {
      i = maskCode(line, i + 2, out, true) + 1
      continue
    }
    const end = Math.min(char === "\\" ? i + 2 : i + 1, line.length)
    blank(out, i, end)
    i = end
  }
  return line.length
}

function quotedEnd(line: string, start: number, quote: string): number {
  let i = start + 1
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2
      continue
    }
    if (line[i] === quote) return i + 1
    i += 1
  }
  return line.length
}

function blank(out: string[], from: number, to: number): void {
  for (let k = from; k < to; k += 1) out[k] = " "
}

function extractHoverPayload(result: unknown): string | null {
  if (result === null || result === undefined) return null
  if (typeof result === "object") {
    const hover = result as { text?: string }
    if (typeof hover.text === "string") return hover.text
  }
  return null
}

const OWNER_CLASS_PATTERN = /\((?:method|property|getter|setter)\)\s+([A-Za-z_$][A-Za-z0-9_$]*)\./
const CLASS_METHOD_PATTERN = /class\s+([A-Za-z_$][A-Za-z0-9_$]*)/

function extractOwnerClassName(hoverText: string): string | null {
  const primary = OWNER_CLASS_PATTERN.exec(hoverText)
  if (primary !== null && primary[1] !== undefined) return primary[1]
  const secondary = CLASS_METHOD_PATTERN.exec(hoverText)
  if (secondary !== null && secondary[1] !== undefined) return secondary[1]
  return null
}

const THROWS_JSDOC_PATTERN =
  /@(?:throws?|exception)(?![\w$])[ \t]*(?:\{([^}\n]+)\})?((?:(?!\n[ \t]*@|[ \t]@[a-zA-Z])[\s\S])*)/g
/** `@link X`, `@linkcode X` or `@linkplain X` in a `{…}`, and `X` when it names a declaration. */
const THROWS_LINK_PATTERN =
  /^@link(?:code|plain)?\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:[\s|]|$)/
/** A brace-less tag's whole text, read as a type: an identifier or path, upper-case first. */
const THROWS_PLAIN_PATTERN = /^[A-Z][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

function extractInferredThrowsFromHover(hoverText: string): string[] {
  const out = new Set<string>()
  for (const match of hoverText.matchAll(THROWS_JSDOC_PATTERN)) {
    const braced = match[1]?.trim()
    if (braced !== undefined) {
      const typed = braced.startsWith("@") ? THROWS_LINK_PATTERN.exec(braced)?.[1] : braced
      if (typed !== undefined && typed.length > 0) out.add(typed)
      continue
    }
    const text = (match[2] ?? "").replace(/\s+/g, " ").trim()
    if (THROWS_PLAIN_PATTERN.test(text)) out.add(text)
  }
  return [...out]
}

function findClassSymbolId(
  caller: IRSymbol,
  className: string,
  workingById: Map<SymbolId, IRSymbol>,
): SymbolId | null {
  const expectedId = trySymbolId({
    language: caller.language,
    file: caller.source.file,
    qualifiedName: className,
  })
  if (expectedId !== null && workingById.has(expectedId)) return expectedId
  for (const s of workingById.values()) {
    if (s.language === caller.language && s.name === className && s.kind === "class") {
      return s.id
    }
  }
  return null
}

function findMemberSymbolId(
  language: string,
  callerFile: string,
  className: string,
  methodName: string,
  workingById: Map<SymbolId, IRSymbol>,
): SymbolId | null {
  const idInSameFile = trySymbolId({
    language,
    file: callerFile,
    qualifiedName: `${className}.${methodName}`,
  })
  if (idInSameFile !== null && workingById.has(idInSameFile)) return idInSameFile
  for (const s of workingById.values()) {
    if (s.language === language && s.name === `${className}.${methodName}`) return s.id
  }
  return null
}

/** What a document symbol names a Symbol by: the segment after its last `.` or `::`. */
function lastSegment(qualifiedName: string): string {
  return lastQnameSegment(qualifiedName)
}

async function defaultServerFactory(
  _language: LanguageId,
  serverConfig: LspServerConfig,
  workspaceRoot: string,
): Promise<LspClient | null> {
  let server: SpawnedServer
  try {
    server = spawnStdioServer(serverConfig.command, serverConfig.args ?? [], workspaceRoot)
  } catch {
    return null
  }
  const spawnOutcome = await Promise.race([
    server.spawnError,
    new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 100)),
  ])
  if (spawnOutcome !== null) return null
  return createLspClient(server)
}
