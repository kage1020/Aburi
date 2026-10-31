import type {
  Config,
  Symbol as IRSymbol,
  LanguageId,
  Logger,
  LspServerConfig,
  SymbolId,
} from "@aburi/types"
import { groupBy } from "../collections"
import { silentLogger } from "../logger"
import { compareBy, compareCodeUnit } from "../order"
import {
  createLspClient,
  errorMessage,
  failureReason,
  isLspFailure,
  type LspClient,
  SHUTDOWN_GRACE_MS,
} from "./client"
import { createFallbackState } from "./fallback"
import { enrichLanguageFiles } from "./file-pass"
import { createStatsBuilder, finalizeStats, type LspProducerStats } from "./stats"
import { type SpawnedServer, spawnStdioServer } from "./transport"

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
  /**
   * The loaded language plugins' ids. Without them an unknown `lsp.servers` key cannot be told
   * from a plugin that was not loaded, so `null` checks no key.
   */
  languageIds: readonly LanguageId[] | null
  logger?: Logger
  serverFactory?: ServerFactory
  now?: () => number
}

export interface EnrichmentResult {
  symbols: IRSymbol[]
  receiverHints: ReadonlyMap<string, ReceiverHint>
  implementerHints: ReadonlyMap<SymbolId, readonly SymbolId[]>
  stats: LspProducerStats | undefined
  /** Returned rather than logged, so a caller that scans twice can say which scan each came from. */
  warnings: readonly string[]
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
  if (input.lspConfig?.enabled !== true) return untouched(input.symbols, [])
  const { servers } = input.lspConfig
  const warnings = serverKeyWarnings(Object.keys(servers ?? {}), input.languageIds)
  if (servers === undefined) return untouched(input.symbols, warnings)

  const logger: Logger = input.logger ?? silentLogger
  const stats = createStatsBuilder(false)
  const fallback = createFallbackState()
  const workingSymbols = input.symbols.map(cloneSymbol)
  const workingById = new Map(workingSymbols.map((symbol) => [symbol.id, symbol]))
  const receiverHints = new Map<string, ReceiverHint>()
  const factory = input.serverFactory ?? defaultServerFactory
  const disableLanguage = (language: LanguageId, warning: string): void => {
    logger.warn?.(warning)
    stats.languagesDisabled.add(language)
  }

  const symbolsByLanguage = groupBy(input.symbols, (symbol) => symbol.language)
  for (const [language, langSymbols] of [...symbolsByLanguage].sort(compareBy(([id]) => id))) {
    const serverConfig = servers[language]
    if (serverConfig === undefined) continue
    stats.enabled = true

    let client: LspClient | null
    try {
      client = await factory(language, serverConfig, input.workspaceRoot)
    } catch (error) {
      disableLanguage(
        language,
        `[aburi:lsp] failed to spawn server for ${language}: ${errorMessage(error)}`,
      )
      continue
    }
    if (client === null) {
      disableLanguage(language, `[aburi:lsp] server not available for ${language}`)
      continue
    }

    try {
      const initResult = await client.initialize({
        workspaceRoot: input.workspaceRoot,
        initializationOptions: serverConfig.initializationOptions ?? {},
        capabilities: CLIENT_CAPABILITIES,
        timeoutMs: serverConfig.initializeTimeoutMs ?? 10000,
      })
      if (isLspFailure(initResult)) {
        disableLanguage(
          language,
          `[aburi:lsp] initialize failed for ${language} (${failureReason(initResult)}); falling back to untyped tier for this language`,
        )
        continue
      }
      await enrichLanguageFiles({
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
        warnings,
        logger,
        now: input.now ?? (() => performance.now()),
      })
    } catch (error) {
      disableLanguage(
        language,
        `[aburi:lsp] enrichment for ${language} threw (${errorMessage(error)}); falling back to untyped tier for this language`,
      )
      logger.debug?.(`[aburi:lsp] enrichment for ${language} threw`, {
        language,
        error: error instanceof Error ? error.name : typeof error,
        stack: error instanceof Error ? error.stack : undefined,
      })
    } finally {
      await safeShutdown(client, language, logger)
    }
  }

  return {
    symbols: workingSymbols,
    receiverHints,
    implementerHints: new Map(),
    stats: finalizeStats(stats),
    warnings,
  }
}

function untouched(symbols: readonly IRSymbol[], warnings: readonly string[]): EnrichmentResult {
  return {
    symbols: [...symbols],
    receiverHints: new Map(),
    implementerHints: new Map(),
    stats: undefined,
    warnings,
  }
}

function serverKeyWarnings(
  keys: readonly string[],
  languageIds: readonly LanguageId[] | null,
): string[] {
  if (languageIds === null) return []
  const known = new Set<string>(languageIds)
  const loaded = [...known].sort(compareCodeUnit).join(", ") || "none"
  const configured = [...keys].sort(compareCodeUnit)
  if (!configured.some((key) => known.has(key))) {
    return [
      `No lsp.servers key names a loaded language plugin (configured: ${configured.join(", ") || "none"}; loaded: ${loaded}), so LSP enrichment starts no server.`,
    ]
  }
  return configured
    .filter((key) => !known.has(key))
    .map(
      (key) =>
        `lsp.servers.${key} matches no loaded language plugin (loaded: ${loaded}); its server is never started.`,
    )
}

function cloneSymbol(symbol: IRSymbol): IRSymbol {
  return {
    ...symbol,
    source: { ...symbol.source },
    component: symbol.component ?? null,
    signature: symbol.signature == null ? null : cloneSignature(symbol.signature),
    calls: symbol.calls.map((c) => ({ ...c })),
    decorators: symbol.decorators.map((d) => ({ ...d })),
    rules: symbol.rules.map((r) => ({ ...r })),
    effects: symbol.effects.map((e) => ({ ...e })),
    ...(symbol.middleware === undefined ? {} : { middleware: [...symbol.middleware] }),
    fingerprint: { ...symbol.fingerprint },
  }
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
