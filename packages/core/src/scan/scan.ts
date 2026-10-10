import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import type {
  Component,
  Config,
  EffectPlugin,
  FrameworkPlugin,
  IR,
  LanguagePlugin,
  Logger,
  UnresolvedCallDiagnostic,
  VocabRegistry,
  WorkspaceManager,
} from "@aburi/types"
import { resolveCallGraph } from "../callgraph"
import { serializeCanonical } from "../canonical"
import { CoreError } from "../errors"
import { logicFingerprint } from "../fingerprint"
import { assertIRIntegrity } from "../integrity"
import { silentLogger } from "../logger"
import { enrichWithLsp, type ServerFactory, withHintUsage } from "../lsp"
import { compareBy } from "../order"
import { propagateEffects } from "../propagate"
import { discoverFiles, type SkippedFile, type UnrepresentableFile } from "./discover"
import {
  buildPluginRefs,
  buildStats,
  projectSymbolEdges,
  sortComponents,
  uniqueSorted,
} from "./document"
import { type ExtractionFailure, extractFiles, type ParseErrorRecord } from "./extract-files"
import type { TreeReleaseFailure } from "./pipeline"
import { buildLanguageRouter } from "./route"
import type { ClassifyTimeoutEvent, ParseTimeoutEvent } from "./timeout"
import type { UndeclaredVocabOccurrence } from "./vocab"

export type { ExtractionFailure, ParseErrorRecord } from "./extract-files"

export interface ScanInput {
  workspaceRoot: string
  config: Config
  languages: readonly LanguagePlugin[]
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  logger?: Logger
  workspaceManagers?: readonly WorkspaceManager[]
  components?: readonly Component[]
  generator?: { name: string; version: string }
  lspServerFactory?: ServerFactory
}

export interface ScanResult {
  ir: IR
  parseErrors: readonly ParseErrorRecord[]
  skipped: readonly SkippedFile[]
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  parseTimeouts: readonly ParseTimeoutEvent[]
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  extractionFailures: readonly ExtractionFailure[]
  treeReleaseFailures: readonly TreeReleaseFailure[]
  undeclaredVocab: readonly UndeclaredVocabOccurrence[]
  unrepresentableFiles: readonly UnrepresentableFile[]
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

  const extracted = await extractFiles({
    workspaceRoot: input.workspaceRoot,
    files: discovered.files,
    router,
    config: input.config,
    frameworks: input.frameworks,
    effects: input.effects,
    registry: input.registry,
    components: input.components ?? [],
    logger,
  })
  const { symbols } = extracted

  symbols.sort(compareBy((symbol) => symbol.id))

  const enrichmentInput: Parameters<typeof enrichWithLsp>[0] = {
    symbols,
    workspaceRoot: input.workspaceRoot,
    fileContents: extracted.fileContents,
    lspConfig: input.config.lsp,
    logger,
  }
  if (input.lspServerFactory !== undefined) enrichmentInput.serverFactory = input.lspServerFactory
  const enrichment = await enrichWithLsp(enrichmentInput)
  const enrichedSymbols = enrichment.symbols
  enrichedSymbols.sort(compareBy((symbol) => symbol.id))

  const callGraph = resolveCallGraph({
    symbols: enrichedSymbols,
    importsByFile: extracted.importsByFile,
    receiverHints: enrichment.receiverHints,
    implementerHints: enrichment.implementerHints,
    dynamicCallSites: extracted.dynamicCallSites,
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

  const skipped = [...discovered.skipped, ...extracted.skipped].sort(compareBy((file) => file.path))
  const stats = buildStats({
    totalFiles: discovered.files.length + discovered.skipped.length,
    parsedFiles: discovered.files.length - extracted.skipped.length,
    skipped,
    symbols: propagatedSymbols,
    timeoutEvents: extracted.timeoutEvents,
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
    parseErrors: extracted.parseErrors,
    skipped,
    timeoutEvents: extracted.timeoutEvents,
    parseTimeouts: extracted.parseTimeouts,
    unresolvedCalls: callGraph.diagnostics,
    extractionFailures: extracted.extractionFailures,
    treeReleaseFailures: extracted.treeReleaseFailures,
    unrepresentableFiles: discovered.unrepresentableFiles,
    undeclaredVocab: extracted.undeclaredVocab,
  }
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
