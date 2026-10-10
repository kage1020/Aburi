import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type {
  CallResolutionStats,
  Component,
  Config,
  Dependency,
  EffectClassifyTimeout,
  EffectPlugin,
  FrameworkPlugin,
  ImportEdge,
  IR,
  Symbol as IRSymbol,
  LanguagePlugin,
  Logger,
  LspEnrichmentStats,
  ParseError,
  PluginRef,
  SourceFile,
  Stats,
  UnresolvedCallDiagnostic,
  VocabRegistry,
  WorkspaceManager,
} from "@aburi/types"
import { dependencyKey } from "../call-site"
import { type CallEdge, resolveCallGraph } from "../callgraph"
import { serializeCanonical } from "../canonical"
import { countBy } from "../collections"
import { CoreError } from "../errors"
import { logicFingerprint } from "../fingerprint"
import { symbolIdFile } from "../id"
import { assertIRIntegrity } from "../integrity"
import { silentLogger } from "../logger"
import { enrichWithLsp, type ReadFile, type ServerFactory, withHintUsage } from "../lsp"
import { compareBy, compareCodeUnit } from "../order"
import { type PropagationStats, propagateEffects } from "../propagate"
import { buildComponentAttribution } from "./attribute"
import {
  type DiscoveredFile,
  discoverFiles,
  type SkippedFile,
  type UnrepresentableFile,
} from "./discover"
import { buildDropCFilter } from "./drop-c"
import { describeThrown, errorCode, isVanishedFile } from "./faults"
import { runFilePipeline, type TreeReleaseFailure } from "./pipeline"
import { buildLanguageRouter } from "./route"
import type { ClassifyTimeoutEvent, ParseTimeoutEvent } from "./timeout"
import { isStrict, type UndeclaredVocabOccurrence, VocabCheck } from "./vocab"

export interface ScanInput {
  /** Absolute workspace root. Every relative path in the IR is measured against this. */
  workspaceRoot: string
  /** Aburi config (from @aburi/config resolve). */
  config: Config
  languages: readonly LanguagePlugin[]
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  logger?: Logger
  workspaceManagers?: readonly WorkspaceManager[]
  components?: readonly Component[]
  /** Generator metadata for `IR.generator`. Callers (the CLI) fill in name + version. */
  generator?: { name: string; version: string }
  lspServerFactory?: ServerFactory
}

export interface ScanResult {
  ir: IR
  parseErrors: readonly ParseErrorRecord[]
  skipped: readonly SkippedFile[]
  /** Rich timeout observations for logging / CI signals. Aggregated into `ir.stats` too. */
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  parseTimeouts: readonly ParseTimeoutEvent[]
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  extractionFailures: readonly ExtractionFailure[]
  treeReleaseFailures: readonly TreeReleaseFailure[]
  undeclaredVocab: readonly UndeclaredVocabOccurrence[]
  unrepresentableFiles: readonly UnrepresentableFile[]
}

export interface ExtractionFailure {
  file: string
  message: string
  code?: string
}

export interface ParseErrorRecord {
  file: string
  errors: readonly ParseError[]
}

export async function scan(input: ScanInput): Promise<ScanResult> {
  assertWorkspaceRootAbsolute(input.workspaceRoot)
  const logger = input.logger ?? silentLogger

  const router = buildLanguageRouter(input.languages)
  const langDropPatterns = languageFileDropPatterns(input.languages)

  const discoverOptions: Parameters<typeof discoverFiles>[0] = {
    workspaceRoot: input.workspaceRoot,
    ignore: input.config.ignore ?? [],
    langDropPatterns,
    respectGitignore: input.config.respectGitignore ?? true,
    languageExtensions: router.knownExtensions,
  }
  if (input.config.maxFileSizeBytes !== undefined) {
    discoverOptions.maxFileSizeBytes = input.config.maxFileSizeBytes
  }
  const discovered = await discoverFiles(discoverOptions)

  const attribute = buildComponentAttribution(input.components ?? [])

  const dropCFilterInput: Parameters<typeof buildDropCFilter>[0] = {
    pluginDropCallees: input.effects.flatMap((e) => e.dropCallees ?? []),
  }
  if (input.config.suppress !== undefined) dropCFilterInput.suppress = input.config.suppress
  if (input.config.keep !== undefined) dropCFilterInput.keep = input.config.keep
  const dropCFilter = buildDropCFilter(dropCFilterInput)

  const symbols: IR["symbols"] = []
  const parseErrors: ParseErrorRecord[] = []
  const timeoutEvents: ClassifyTimeoutEvent[] = []
  const additionalSkipped: SkippedFile[] = []
  const parseTimeouts: ParseTimeoutEvent[] = []
  const extractionFailures: ExtractionFailure[] = []
  const treeReleaseFailures: TreeReleaseFailure[] = []
  const undeclaredVocab: UndeclaredVocabOccurrence[] = []
  const strictVocab = isStrict(input.config)
  const warnedReleaseFailure = new Set<string>()
  const importsByFile = new Map<string, readonly ImportEdge[]>()
  const fileContents = new Map<string, ReadFile>()
  const dynamicCallSites = new Set<string>()
  for (const discoveredFile of discovered.files) {
    const language = router.route(discoveredFile.path)
    if (language === null) {
      additionalSkipped.push({
        path: discoveredFile.path,
        reason: "unroutable",
        detail: "extension survived discovery filter but no plugin claims it",
      })
      continue
    }

    let sourceFile: SourceFile
    try {
      sourceFile = await loadSourceFile(input.workspaceRoot, discoveredFile)
    } catch (error) {
      if (!isVanishedFile(error)) throw error
      const detail = describeThrown(error)
      additionalSkipped.push({ path: discoveredFile.path, reason: "unreadable", detail })
      logger.warn(
        `Skipped ${discoveredFile.path}: it was no longer a file by the time it was read — ${detail}`,
      )
      continue
    }

    let result: Awaited<ReturnType<typeof runFilePipeline>>
    const releasesRecordedBefore = treeReleaseFailures.length
    const fileVocab = new VocabCheck(input.registry, strictVocab)
    try {
      result = await runFilePipeline({
        file: sourceFile,
        language,
        frameworks: input.frameworks,
        effects: input.effects,
        registry: input.registry,
        config: input.config,
        dropCFilter,
        component: attribute(sourceFile.path),
        log: logger,
        treeReleaseFailures,
        vocab: fileVocab,
      })
    } catch (error) {
      if (isPluginSetFault(error)) throw error
      const message = describeThrown(error)
      additionalSkipped.push({
        path: discoveredFile.path,
        reason: "extraction-failed",
        detail: message,
      })
      const code = errorCode(error)
      extractionFailures.push({
        file: discoveredFile.path,
        message,
        ...(code === null ? {} : { code }),
      })
      logger.warn(`Skipped ${discoveredFile.path}: extraction threw — ${message}`)
      continue
    } finally {
      for (const failure of treeReleaseFailures.slice(releasesRecordedBefore)) {
        if (warnedReleaseFailure.has(failure.plugin)) continue
        warnedReleaseFailure.add(failure.plugin)
        logger.warn(
          `Plugin ${failure.plugin} did not release the parse tree for ${failure.file}: ${failure.detail}. ` +
            "A tree the plugin does not free is not reclaimed by the garbage collector, so a long " +
            "enough run exhausts the parser's heap.",
        )
      }
    }

    if (result.parseErrors.length > 0) {
      parseErrors.push({ file: discoveredFile.path, errors: result.parseErrors })
    }

    switch (result.kind) {
      case "parse-timeout": {
        const spent = Math.round(result.timeout.elapsedMs)
        const budget = result.timeout.budgetMs
        parseTimeouts.push(result.timeout)
        additionalSkipped.push({
          path: discoveredFile.path,
          reason: result.kind,
          detail: `extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms)`,
        })
        logger.warn(
          `Skipped ${discoveredFile.path}: extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms). Override with config.parseTimeoutMs.`,
        )
        break
      }
      case "parse-failed": {
        const detail = describeParseFailure(result.parseErrors)
        additionalSkipped.push({ path: discoveredFile.path, reason: result.kind, detail })
        logger.warn(`Skipped ${discoveredFile.path}: ${detail}`)
        importsByFile.set(result.path, result.imports)
        break
      }
      case "extracted": {
        const collision = describeIdFault(result.symbols, discoveredFile.path)
        if (collision !== null) {
          additionalSkipped.push({
            path: discoveredFile.path,
            reason: "extraction-failed",
            detail: collision,
          })
          extractionFailures.push({
            file: discoveredFile.path,
            message: collision,
            code: "duplicate-symbol-id",
          })
          logger.warn(`Skipped ${discoveredFile.path}: ${collision}`)
          timeoutEvents.push(...result.timeoutEvents)
          importsByFile.set(discoveredFile.path, result.imports)
          break
        }

        undeclaredVocab.push(...fileVocab.occurrences)

        fileContents.set(sourceFile.path, {
          content: sourceFile.content,
          fsPath: discoveredFile.fsPath,
        })

        timeoutEvents.push(...result.timeoutEvents)
        symbols.push(...result.symbols)
        importsByFile.set(result.path, result.imports)
        for (const key of result.dynamicCallSites) dynamicCallSites.add(key)
        break
      }
      default:
        throw unhandledOutcome(result)
    }
  }

  for (const [plugin, count] of countBy(treeReleaseFailures, (failure) => failure.plugin)) {
    if (count > 1) {
      logger.warn(`Plugin ${plugin} failed to release ${count} parse trees over this run.`)
    }
  }

  symbols.sort(compareBy((symbol) => symbol.id))

  const enrichmentInput: Parameters<typeof enrichWithLsp>[0] = {
    symbols,
    workspaceRoot: input.workspaceRoot,
    fileContents,
    lspConfig: input.config.lsp,
    logger,
  }
  if (input.lspServerFactory !== undefined) enrichmentInput.serverFactory = input.lspServerFactory
  const enrichment = await enrichWithLsp(enrichmentInput)
  const enrichedSymbols = enrichment.symbols
  enrichedSymbols.sort(compareBy((symbol) => symbol.id))

  const callGraph = resolveCallGraph({
    symbols: enrichedSymbols,
    importsByFile,
    receiverHints: enrichment.receiverHints,
    implementerHints: enrichment.implementerHints,
    dynamicCallSites,
  })
  const symbolEdges = projectSymbolEdges(callGraph.edges)

  const propagation = propagateEffects({
    symbols: callGraph.symbols,
    edges: callGraph.edges,
  })
  const propagatedSymbols = propagation.symbols.map((s) =>
    s.dropped
      ? s
      : {
          ...s,
          fingerprint: { ...s.fingerprint, logic: logicFingerprint(s) },
        },
  )

  const skipped = [...discovered.skipped, ...additionalSkipped].sort(compareBy((file) => file.path))
  const stats = buildStats({
    totalFiles: discovered.files.length + discovered.skipped.length,
    parsedFiles: discovered.files.length - additionalSkipped.length,
    skipped,
    symbols: propagatedSymbols,
    timeoutEvents,
    propagation: propagation.stats,
    lspEnrichment:
      enrichment.stats === undefined
        ? undefined
        : withHintUsage(enrichment.stats, callGraph.lspHintUsage),
    callResolution: callGraph.stats,
  })

  const workspace: IR["workspace"] = {
    root: ".",
    managers: [...(input.workspaceManagers ?? [])],
    languages: uniqueSorted(input.languages.map((l) => l.languageId)),
  }

  const ir: IR = {
    $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
    generator: {
      name: input.generator?.name ?? "@aburi/core",
      version: input.generator?.version ?? "0.0.0",
      plugins: buildPluginRefs(input),
    },
    workspace,
    components: sortComponents(input.components ?? []),
    symbols: propagatedSymbols,
    dependencies: symbolEdges,
    stats,
  }

  assertIRIntegrity(ir)

  return {
    ir,
    parseErrors,
    skipped,
    timeoutEvents,
    parseTimeouts,
    unresolvedCalls: callGraph.diagnostics,
    extractionFailures,
    treeReleaseFailures,
    unrepresentableFiles: discovered.unrepresentableFiles,
    undeclaredVocab,
  }
}

function describeParseFailure(errors: readonly ParseError[]): string {
  const fatal = errors.find((error) => error.recoverable === false)
  if (fatal !== undefined) return `parse reported a non-recoverable error at ${quote(fatal)}`
  const first = errors[0]
  if (first === undefined) return "the language plugin returned no tree"
  return `the language plugin returned no tree; first error at ${quote(first)}`
}

function quote(error: ParseError): string {
  return `${error.line}:${error.column} — ${error.message}`
}

function describeIdFault(symbols: readonly IRSymbol[], path: string): string | null {
  const here = new Map<string, IRSymbol>()
  for (const symbol of symbols) {
    const claimed = symbolIdFile(symbol.id)
    if (claimed !== null && claimed !== path) {
      return (
        `Symbol id "${symbol.id}" names ${claimed}, which is not this file. An id carries the ` +
        `file its Symbol was declared in, so the language plugin wrote a path that is not ` +
        `this file's`
      )
    }
    const twin = here.get(symbol.id)
    if (twin !== undefined) {
      // The lines, because the id names the qualified name the two share and nothing else
      // tells them apart — the reader has two declarations to find, not one.
      return (
        `two Symbols share the id "${symbol.id}" (lines ${twin.source.startLine} and ` +
        `${symbol.source.startLine}); the language plugin gave two declarations one qualified ` +
        `name, and nothing it reported separates them`
      )
    }
    here.set(symbol.id, symbol)
  }
  return null
}

const PLUGIN_SET_FAULT_CODES: ReadonlySet<string> = new Set([
  "scan-plugin-misconfigured",
  "invalid-language-id",
  "vocab-undeclared",
])

function isPluginSetFault(error: unknown): boolean {
  const code = errorCode(error)
  return code !== null && PLUGIN_SET_FAULT_CODES.has(code)
}

export interface WriteCanonicalIROptions {
  format?: "pretty" | "compact"
}

export async function writeCanonicalIR(
  ir: IR,
  outputPath: string,
  options: WriteCanonicalIROptions = {},
): Promise<string> {
  const serialized = serializeCanonical(ir, { format: options.format ?? "pretty" })
  const { writeFile, mkdir } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serialized, "utf8")
  return serialized
}

function assertWorkspaceRootAbsolute(root: string): void {
  if (!isAbsolute(root)) {
    throw new CoreError(
      `ScanInput.workspaceRoot must be an absolute path, got "${root}". A relative root would be resolved against process.cwd() and produce non-portable Symbol ids.`,
      { code: "scan-workspace-not-absolute", value: root },
    )
  }
}

export function languageFileDropPatterns(languages: readonly LanguagePlugin[]): string[] {
  const patterns: string[] = []
  for (const language of languages) {
    if (language.fileDropPatterns) patterns.push(...language.fileDropPatterns)
  }
  return patterns
}

/**
 * `fsPath` opens it, `path` names it.
 *
 * The two differ whenever the filesystem stores a name that is not already in NFC, and reading
 * by the Document's spelling misses on every filesystem that keeps what it was given. What the
 * plugin then sees is `path`, because that is what its Symbol ids are built from and what the
 * Document records — the filesystem spelling stops here.
 *
 * The content's line terminators stop here too: CRLF and a lone CR become LF, so the Document
 * does not depend on the checkout (`core.autocrlf`, an editor's setting). Without it a line
 * break inside a template literal reached the `syntax` fingerprint as `\r\n` on one checkout
 * and `\n` on another, and every field copied from source text carried the `\r`
 * (fingerprint.md §5.3). The program is unchanged — ECMAScript reads CRLF and a lone CR in a
 * template literal as LF. Line numbers and columns are unchanged for a CRLF file, whose CR sat
 * at the end of its line; a file that breaks lines with CR alone, which read as one line, gains
 * the lines it was written with.
 */
async function loadSourceFile(
  workspaceRoot: string,
  discovered: DiscoveredFile,
): Promise<SourceFile> {
  const absolute = resolve(workspaceRoot, discovered.fsPath)
  const content = await readFile(absolute, "utf8")
  return { path: discovered.path, content: normalizeLineTerminators(content) }
}

/**
 * CRLF and a lone CR to LF, for `loadSourceFile`. Exported for its tests; it is not part of the
 * package's API.
 */
export function normalizeLineTerminators(content: string): string {
  return content.includes("\r") ? content.replace(/\r\n?/g, "\n") : content
}

interface BuildStatsInput {
  totalFiles: number
  parsedFiles: number
  skipped: readonly SkippedFile[]
  symbols: readonly IR["symbols"][number][]
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  propagation: PropagationStats
  lspEnrichment?: LspEnrichmentStats | undefined
  callResolution: CallResolutionStats
}

function buildStats(input: BuildStatsInput): Stats {
  const kept = input.symbols.filter((s) => !s.dropped).length
  const dropped = input.symbols.length - kept
  const stats: Stats = {
    totalFiles: input.totalFiles,
    parsedFiles: input.parsedFiles,
    keptSymbols: kept,
    droppedSymbols: dropped,
    effectPropagation: input.propagation,
    callResolution: input.callResolution,
  }
  if (input.timeoutEvents.length > 0) {
    stats.effectClassifyTimeouts = input.timeoutEvents.map(
      (event): EffectClassifyTimeout => ({
        plugin: event.plugin,
        symbolId: event.symbolId,
        timeoutMs: event.budgetMs,
      }),
    )
  }
  if (input.lspEnrichment !== undefined) {
    stats.lspEnrichment = input.lspEnrichment
  }
  if (input.skipped.length > 0) {
    stats.skippedFiles = input.skipped.map((file) => ({ path: file.path, reason: file.reason }))
  }
  return stats
}

function sortComponents(components: readonly Component[]): Component[] {
  return components
    .map((c) => ({ ...c, description: c.description ?? null }))
    .sort(compareBy((component) => component.id))
}

function projectSymbolEdges(edges: readonly CallEdge[]): Dependency[] {
  const seen = new Set<string>()
  const out: Dependency[] = []
  for (const edge of edges) {
    const key = dependencyKey(edge.from, edge.to, edge.via)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      from: edge.from,
      to: edge.to,
      via: edge.via,
      direction: "outbound",
      effect: null,
    })
  }
  out.sort(
    (a, b) =>
      compareCodeUnit(a.from, b.from) ||
      compareCodeUnit(a.to, b.to) ||
      compareCodeUnit(a.via, b.via),
  )
  return out
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodeUnit)
}

function buildPluginRefs(input: ScanInput): PluginRef[] {
  const refs: PluginRef[] = []
  for (const plugin of input.languages)
    refs.push(buildPluginRef(plugin.manifest.name, "lang", plugin.manifest.version))
  for (const plugin of input.frameworks)
    refs.push(buildPluginRef(plugin.manifest.name, "framework", plugin.manifest.version))
  for (const plugin of input.effects)
    refs.push(buildPluginRef(plugin.manifest.name, "effects", plugin.manifest.version))
  refs.sort(compareBy((ref) => ref.name))
  return refs
}

const PENDING_GRAMMAR_REVISION = "pending@0.0.0"

function buildPluginRef(name: string, type: PluginRef["type"], version: string): PluginRef {
  return {
    name,
    type,
    version,
    grammarRevision: type === "lang" ? PENDING_GRAMMAR_REVISION : null,
  }
}

function unhandledOutcome(outcome: never): CoreError {
  return new CoreError(
    `Internal error: the scan does not handle the file outcome ${describeThrown(outcome)}\n` +
      "This is a bug in Aburi — please report it at https://github.com/kage1020/Aburi/issues.",
    { code: "scan-outcome-unhandled" },
  )
}
