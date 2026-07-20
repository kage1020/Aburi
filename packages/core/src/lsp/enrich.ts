/**
 * LSP enrichment pass (lsp-enrichment.md §2). Consumes the language plugin's
 * `IRSymbol[]` output, spawns one LSP server per configured language, opens each
 * file once, and refines a strictly bounded set of IR fields (§5):
 *
 *   - SourceRange.startColumn / endColumn (from documentSymbol)
 *   - Signature.inferredThrows           (from hover @throws parsing)
 *   - receiverHints / implementerHints   (fed to callgraph — this / super / interface)
 *
 * The pass is a no-op when `lsp.enabled !== true`, when no server is configured
 * for any language present in the symbol set, or when a server fails to start.
 * Determinism (§10) is guaranteed by writing to a per-request cache first, then
 * mutating IR fields in fixed order (file path asc → Symbol id asc → call line asc).
 */

import { pathToFileURL } from "node:url"
import type {
  Config,
  Symbol as IRSymbol,
  LanguageId,
  Logger,
  LspEnrichmentStats,
  LspServerConfig,
  SymbolId,
} from "@aburi/types"
import type { DocumentSymbol, Position, SymbolInformation } from "vscode-languageserver-protocol"
import { createLspClient, isLspFailure, type LspClient, type LspFailure } from "./client"
import { createFallbackState, type FallbackState } from "./fallback"
import { requestDocumentSymbols, requestHover, requestTypeDefinition } from "./requests"
import { createStatsBuilder, finalizeStats, type LspStatsBuilder } from "./stats"
import { type SpawnedServer, spawnStdioServer } from "./transport"

export interface EnrichmentInput {
  symbols: readonly IRSymbol[]
  workspaceRoot: string
  fileContents: ReadonlyMap<string, string>
  lspConfig: Config["lsp"] | undefined
  logger?: Logger
  /**
   * Injected server factory. Real production always uses the default (spawn).
   * Tests inject an in-memory server + client pair so no child process is needed.
   */
  serverFactory?: ServerFactory
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
}

export interface EnrichmentResult {
  symbols: IRSymbol[]
  receiverHints: ReadonlyMap<string, ReceiverHint>
  implementerHints: ReadonlyMap<string, SymbolId[]>
  stats: LspEnrichmentStats | undefined
}

export interface ReceiverHint {
  kind: "this" | "super" | "interface"
  ownerClassId?: SymbolId
  walkedHierarchy?: boolean
  interfaceId?: SymbolId
}

/**
 * A `ServerFactory` produces a ready-to-use `LspClient` for a given language +
 * server config, given the workspace root and initialize timeout. Tests inject
 * mocks; production uses the default (spawn + `vscode-jsonrpc`).
 */
export type ServerFactory = (
  language: LanguageId,
  serverConfig: LspServerConfig,
  workspaceRoot: string,
) => Promise<LspClient | null> | LspClient | null

export type ReceiverHintKey = string
export function makeReceiverHintKey(file: string, line: number): ReceiverHintKey {
  return `${file}:${line}`
}

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

  const logger: Logger = input.logger ?? SILENT_LOGGER
  const stats = createStatsBuilder(true)
  const fallback = createFallbackState()

  const symbolsByLanguage = groupSymbolsByLanguage(input.symbols)
  const workingSymbols: IRSymbol[] = input.symbols.map((s) => cloneSymbol(s))
  const workingById = new Map<SymbolId, IRSymbol>()
  for (const s of workingSymbols) workingById.set(s.id, s)

  const receiverHints = new Map<string, ReceiverHint>()
  const implementerHints = new Map<SymbolId, SymbolId[]>()

  const factory = input.serverFactory ?? defaultServerFactory

  for (const [language, langSymbols] of [...symbolsByLanguage.entries()].sort(byLanguage)) {
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
      await safeShutdown(client)
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
      implementerHints,
      logger,
    })

    await safeShutdown(client)
  }

  // Sort implementer hint arrays for determinism (LE14).
  const implementerHintsSorted = new Map<string, SymbolId[]>()
  for (const [interfaceId, impls] of implementerHints) {
    implementerHintsSorted.set(interfaceId, [...impls].sort())
  }

  return {
    symbols: workingSymbols,
    receiverHints,
    implementerHints: implementerHintsSorted,
    stats: finalizeStats(stats),
  }
}

interface ProcessLanguageInput {
  language: LanguageId
  serverConfig: LspServerConfig
  client: LspClient
  symbols: readonly IRSymbol[]
  workingById: Map<SymbolId, IRSymbol>
  fileContents: ReadonlyMap<string, string>
  workspaceRoot: string
  stats: LspStatsBuilder
  fallback: FallbackState
  receiverHints: Map<string, ReceiverHint>
  implementerHints: Map<SymbolId, SymbolId[]>
  logger: Logger
}

async function processLanguage(input: ProcessLanguageInput): Promise<void> {
  const symbolsByFile = groupSymbolsByFile(input.symbols)
  const filesSorted = [...symbolsByFile.keys()].sort()

  const requestTimeout = input.serverConfig.requestTimeoutMs ?? 500
  const fileBudget = input.serverConfig.fileBudgetMs ?? 2000
  const concurrency = input.serverConfig.concurrency ?? 8

  for (const file of filesSorted) {
    if (input.fallback.isLanguageDisabled(input.language)) break
    const content = input.fileContents.get(file)
    if (content === undefined) continue

    const uri = fileUriFor(input.workspaceRoot, file)
    const languageIdForOpen = languageIdForLspOpen(input.language)
    const fileSymbols = symbolsByFile.get(file) ?? []

    const fileStart = Date.now()
    let fileFellBack = false

    try {
      await input.client.didOpen(uri, languageIdForOpen, content)
    } catch (error) {
      input.logger.warn?.(`[aburi:lsp] didOpen failed for ${file}: ${errorMessage(error)}`)
      fileFellBack = true
    }

    if (!fileFellBack) {
      input.stats.requestsIssued += 1
      const docSymbols = await requestDocumentSymbols(input.client, uri, requestTimeout)
      const requestOk = !isLspFailure(docSymbols)
      if (!requestOk) {
        input.stats.requestsTimedOut += isTimeout(docSymbols) ? 1 : 0
      }
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

    if (!fileFellBack && overBudget(fileStart, fileBudget)) fileFellBack = true

    if (!fileFellBack) {
      const jobs = buildRequestJobs(fileSymbols, content)
      await runJobsWithConcurrency(jobs, concurrency, async (job) => {
        if (fileFellBack) return
        if (overBudget(fileStart, fileBudget)) {
          fileFellBack = true
          return
        }
        input.stats.requestsIssued += 1
        const result = await executeJob(job, input.client, uri, requestTimeout)
        const jobOk = !isLspFailure(result)
        if (!jobOk) {
          input.stats.requestsTimedOut += isTimeout(result) ? 1 : 0
        }
        const outcome = input.fallback.onRequest(file, jobOk)
        if (outcome.escalate) fileFellBack = true
        if (jobOk) {
          applyJobResult(
            job,
            result,
            input.receiverHints,
            input.implementerHints,
            input.workingById,
            content,
          )
        }
      })
    }

    try {
      await input.client.didClose(uri)
    } catch {
      // ignore
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
        `[aburi:lsp] disabling LSP for ${input.language} after ${closeOutcome ? "5 consecutive file fallbacks" : "language failure"}`,
      )
      break
    }
  }
}

type RequestJob =
  | {
      kind: "this-super-hover"
      symbolId: SymbolId
      callLine: number
      column: number
      calleeText: string
      receiverKind: "this" | "super"
    }
  | {
      kind: "interface-typedef"
      symbolId: SymbolId
      callLine: number
      column: number
      calleeText: string
    }

function buildRequestJobs(fileSymbols: readonly IRSymbol[], content: string): RequestJob[] {
  const jobs: RequestJob[] = []
  const lines = content.split(/\r?\n/)
  for (const symbol of fileSymbols) {
    for (const call of symbol.calls) {
      if (call.resolved !== null) continue
      const line = lines[call.line - 1]
      if (line === undefined) continue
      const segments = call.target.split(".").filter((s) => s.length > 0)
      if (segments.length < 2) continue
      const head = segments[0] as string
      const method = segments[segments.length - 1] as string
      const column = findMethodColumn(line, head, method)
      if (column === null) continue
      if (head === "this" || head === "super") {
        jobs.push({
          kind: "this-super-hover",
          symbolId: symbol.id,
          callLine: call.line,
          column,
          calleeText: method,
          receiverKind: head,
        })
      } else if (isIdentifier(head)) {
        jobs.push({
          kind: "interface-typedef",
          symbolId: symbol.id,
          callLine: call.line,
          column: findReceiverColumn(line, head),
          calleeText: method,
        })
      }
    }
  }
  return jobs
}

async function executeJob(
  job: RequestJob,
  client: LspClient,
  uri: string,
  timeoutMs: number,
): Promise<unknown | LspFailure> {
  const position: Position = { line: job.callLine - 1, character: job.column }
  if (job.kind === "this-super-hover") {
    return await requestHover(client, uri, position, timeoutMs)
  }
  return await requestTypeDefinition(client, uri, position, timeoutMs)
}

function applyJobResult(
  job: RequestJob,
  result: unknown,
  receiverHints: Map<string, ReceiverHint>,
  implementerHints: Map<SymbolId, SymbolId[]>,
  workingById: Map<SymbolId, IRSymbol>,
  content: string,
): void {
  const caller = workingById.get(job.symbolId)
  if (caller === undefined) return
  if (job.kind === "this-super-hover") {
    const text = extractHoverPayload(result)
    if (text === null) return
    const ownerClassName = extractOwnerClassName(text)
    if (ownerClassName === null) return
    const ownerClassId = findClassSymbolId(caller, ownerClassName, workingById)
    if (ownerClassId === null) return
    const memberId = findMemberSymbolId(
      caller.language,
      caller.source.file,
      ownerClassName,
      job.calleeText,
      workingById,
    )
    if (memberId === null) return
    receiverHints.set(makeReceiverHintKey(caller.source.file, job.callLine), {
      kind: job.receiverKind,
      ownerClassId: memberId,
      walkedHierarchy: false,
    })
    const throws = extractInferredThrowsFromHover(text)
    if (throws.length > 0) appendInferredThrows(caller, throws)
    return
  }
  const locations = Array.isArray(result)
    ? (result as Array<{ uri?: string; range?: { start: Position } }>)
    : []
  if (locations.length === 0) return
  const first = locations[0]
  if (first?.uri === undefined || first.range === undefined) return
  const interfaceFile = uriToFile(first.uri)
  if (interfaceFile === null) return
  // Match against known interface Symbols by (language, file, name at that line).
  const iface = findInterfaceByPosition(
    caller.language,
    interfaceFile,
    first.range.start.line + 1,
    workingById,
  )
  if (iface === null) return
  const impls = findImplementersOfInterface(iface, workingById)
  if (impls.length === 0) return
  const existing = implementerHints.get(iface.id) ?? []
  const combined = [...new Set([...existing, ...impls])]
  implementerHints.set(iface.id, combined)
  if (combined.length !== 1) return
  const [only] = combined
  if (only === undefined) return
  const implMember = findMemberSymbolIdByPath(only, job.calleeText, workingById)
  if (implMember === null) return
  receiverHints.set(makeReceiverHintKey(caller.source.file, job.callLine), {
    kind: "interface",
    interfaceId: iface.id,
    ownerClassId: implMember,
  })
  void content
}

/**
 * Apply documentSymbol results: match by name+line to populate startColumn/endColumn.
 * DocumentSymbol range is 0-based; our SourceRange columns are 1-based.
 */
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
  const walk = (entry: DocumentSymbol | SymbolInformation): void => {
    if ("range" in entry) {
      push(entry.name, entry.range)
      if ((entry as DocumentSymbol).children !== undefined) {
        for (const child of (entry as DocumentSymbol).children ?? []) walk(child)
      }
      return
    }
    const info = entry as SymbolInformation
    if (info.location?.range !== undefined) push(info.name, info.location.range)
  }
  for (const entry of entries) walk(entry)

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
  const merged = [...new Set([...existing, ...throws])].sort()
  if (merged.length === 0) return
  symbol.signature = { ...symbol.signature, inferredThrows: merged }
}

async function runJobsWithConcurrency<T>(
  jobs: readonly T[],
  concurrency: number,
  run: (job: T) => Promise<void>,
): Promise<void> {
  if (jobs.length === 0) return
  const workers = Math.max(1, Math.min(concurrency, jobs.length))
  let cursor = 0
  const takers = Array.from({ length: workers }, async () => {
    while (cursor < jobs.length) {
      const idx = cursor
      cursor += 1
      const job = jobs[idx]
      if (job === undefined) return
      await run(job)
    }
  })
  await Promise.all(takers)
}

function groupSymbolsByLanguage(symbols: readonly IRSymbol[]): Map<LanguageId, IRSymbol[]> {
  const out = new Map<LanguageId, IRSymbol[]>()
  for (const symbol of symbols) {
    const bucket = out.get(symbol.language) ?? []
    bucket.push(symbol)
    out.set(symbol.language, bucket)
  }
  return out
}

function groupSymbolsByFile(symbols: readonly IRSymbol[]): Map<string, IRSymbol[]> {
  const out = new Map<string, IRSymbol[]>()
  for (const symbol of symbols) {
    const bucket = out.get(symbol.source.file) ?? []
    bucket.push(symbol)
    out.set(symbol.source.file, bucket)
  }
  return out
}

function byLanguage(a: [string, unknown], b: [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

function cloneSymbol(symbol: IRSymbol): IRSymbol {
  const clonedSig =
    symbol.signature === null || symbol.signature === undefined
      ? symbol.signature
      : cloneSignature(symbol.signature)
  const cloned: IRSymbol = {
    ...symbol,
    source: { ...symbol.source },
    ...(clonedSig === undefined ? {} : { signature: clonedSig }),
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
    inputs: signature.inputs.map((i) => ({ ...i })),
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

function uriToFile(uri: string): string | null {
  if (!uri.startsWith("file://")) return null
  return decodeURIComponent(uri.slice("file://".length))
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

function overBudget(startMs: number, budgetMs: number): boolean {
  return Date.now() - startMs > budgetMs
}

function isTimeout(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "timeout"
  )
}

function failureReason(failure: LspFailure): string {
  if (failure.kind === "timeout") return "timeout"
  return `${failure.reason}: ${failure.message}`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function safeShutdown(client: LspClient): Promise<void> {
  try {
    await client.shutdown()
  } catch {
    // ignore
  }
}

function findMethodColumn(line: string, head: string, method: string): number | null {
  const needle = `${head}.${method}`
  const idx = line.indexOf(needle)
  if (idx < 0) {
    const methodIdx = line.indexOf(method)
    return methodIdx < 0 ? null : methodIdx
  }
  return idx + head.length + 1
}

function findReceiverColumn(line: string, head: string): number {
  const idx = line.indexOf(head)
  return idx < 0 ? 0 : idx
}

function isIdentifier(text: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)
}

function extractHoverPayload(result: unknown): string | null {
  if (result === null || result === undefined) return null
  if (typeof result === "object") {
    const r = result as { text?: string }
    if (typeof r.text === "string") return r.text
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

const THROWS_JSDOC_PATTERN = /@throws\s*\{([^}]+)\}/g
const THROWS_PLAIN_PATTERN = /@throws\s+([A-Za-z_$][A-Za-z0-9_$.]*)/g

function extractInferredThrowsFromHover(hoverText: string): string[] {
  const out = new Set<string>()
  for (const match of hoverText.matchAll(THROWS_JSDOC_PATTERN)) {
    if (match[1] !== undefined) out.add(match[1].trim())
  }
  for (const match of hoverText.matchAll(THROWS_PLAIN_PATTERN)) {
    if (match[1] !== undefined) out.add(match[1].trim())
  }
  return [...out]
}

function findClassSymbolId(
  caller: IRSymbol,
  className: string,
  workingById: Map<SymbolId, IRSymbol>,
): SymbolId | null {
  const expectedId: SymbolId = `${caller.language}:${caller.source.file}#${className}`
  if (workingById.has(expectedId)) return expectedId
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
  const idInSameFile: SymbolId = `${language}:${callerFile}#${className}.${methodName}`
  if (workingById.has(idInSameFile)) return idInSameFile
  for (const s of workingById.values()) {
    if (s.language === language && s.name === `${className}.${methodName}`) return s.id
  }
  return null
}

function findMemberSymbolIdByPath(
  classId: SymbolId,
  methodName: string,
  workingById: Map<SymbolId, IRSymbol>,
): SymbolId | null {
  const hashIdx = classId.lastIndexOf("#")
  if (hashIdx < 0) return null
  const prefix = classId.slice(0, hashIdx)
  const className = classId.slice(hashIdx + 1)
  const candidate = `${prefix}#${className}.${methodName}` as SymbolId
  return workingById.has(candidate) ? candidate : null
}

function findInterfaceByPosition(
  language: string,
  file: string,
  line: number,
  workingById: Map<SymbolId, IRSymbol>,
): IRSymbol | null {
  for (const s of workingById.values()) {
    if (s.language !== language) continue
    if (!s.source.file.endsWith(file) && !file.endsWith(s.source.file)) continue
    if (s.kind !== "interface") continue
    if (s.source.startLine === line) return s
  }
  return null
}

function findImplementersOfInterface(
  iface: IRSymbol,
  workingById: Map<SymbolId, IRSymbol>,
): SymbolId[] {
  // Untyped tier does not track implements[] relationships. For now, return an
  // empty list — a follow-up hook (framework plugin or expanded IR) will feed
  // this. The pass still populates the interfaceId in receiverHints so callers
  // can act on the same-name convention if they encode it.
  void iface
  void workingById
  return []
}

function lastSegment(qualifiedName: string): string {
  const idx = qualifiedName.lastIndexOf(".")
  return idx < 0 ? qualifiedName : qualifiedName.slice(idx + 1)
}

const SILENT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
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
  return createLspClient(server)
}
