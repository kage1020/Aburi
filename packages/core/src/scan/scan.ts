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
import { type CallEdge, resolveCallGraph } from "../callgraph"
import { serializeCanonical } from "../canonical"
import { CoreError } from "../errors"
import { logicFingerprint } from "../fingerprint"
import { assertIRIntegrity } from "../integrity"
import { enrichWithLsp, type ServerFactory } from "../lsp"
import { type PropagationStats, propagateEffects } from "../propagate"
import { type DiscoveredFile, discoverFiles, type SkippedFile } from "./discover"
import { buildDropCFilter } from "./drop-c"
import { runFilePipeline } from "./pipeline"
import { buildLanguageRouter } from "./route"
import type { ClassifyTimeoutEvent, ParseTimeoutEvent } from "./timeout"

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
  /**
   * Optional injected LSP server factory. Real production always uses the
   * default (spawn). Tests inject an in-memory mock so no child process is
   * needed. When omitted the enrichment pass uses `spawnStdioServer` from the
   * `lsp` module.
   */
  lspServerFactory?: ServerFactory
}

export interface ScanResult {
  ir: IR
  parseErrors: readonly ParseErrorRecord[]
  /**
   * Files that contributed no Symbols for a reason other than a parse failure — over-size
   * or unreadable at discovery, unroutable or over its `parseTimeoutMs` budget afterwards.
   * Surfaced separately from parseErrors, which are about files that were read.
   */
  skipped: readonly SkippedFile[]
  /** Rich timeout observations for logging / CI signals. Aggregated into `ir.stats` too. */
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  /**
   * One record per file abandoned for exceeding `config.parseTimeoutMs`, in scan order.
   * These files also appear in `skipped` under `reason: "parse-timeout"`, which is what a
   * reader wanting the count consults; this carries the budget and the wall clock beside
   * it, so a caller can report how far over the file went without parsing a message.
   *
   * Deliberately not in `ir.stats`: unlike `effectClassifyTimeouts`, which records a
   * decision the Document embodies, this records a file the Document does not mention.
   */
  parseTimeouts: readonly ParseTimeoutEvent[]
  /**
   * One record per call the resolver left `resolved: null`, with the §8.1
   * bucket that explains why. Counts are aggregated into
   * `ir.stats.callResolution`; the per-call detail deliberately stays out of
   * the IR (call-resolution.md §8.1) and is surfaced by
   * `aburi explain --debug-resolution`.
   */
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
}

export interface ParseErrorRecord {
  file: string
  errors: readonly ParseError[]
}

/**
 * Top-level scan orchestration — the discover → route → pipeline → IR-assembly →
 * integrity-check chain:
 *
 *   1. File discovery via `discoverFiles` — respects `config.ignore`, `.gitignore`, and
 *      `config.maxFileSizeBytes`. Only files whose extension is claimed by a loaded
 *      language plugin survive.
 *   2. Language routing via `buildLanguageRouter`.
 *   3. Per-file extraction through `runFilePipeline` — parse → extractSymbols →
 *      framework classify → walkBody → effect classify (with per-call timeout) →
 *      Category B/C drop → fingerprint.
 *   4. Assemble the IR (Symbols + Components + Dependencies + Stats), sort every array
 *      per the schema's ordering rules.
 *   5. `assertIRIntegrity` — every ir-schema.md §14 invariant must pass before we hand the IR back.
 *
 * Serialization to disk is the caller's job (`writeCanonicalIR` handles the canonical
 * JSON write). Keeping serialization off the scan path lets tests assert on the IR
 * object directly without touching the filesystem.
 */
export async function scan(input: ScanInput): Promise<ScanResult> {
  assertWorkspaceRootAbsolute(input.workspaceRoot)
  const logger = input.logger ?? silentLogger

  const router = buildLanguageRouter(input.languages)
  const langDropPatterns = collectLangDropPatterns(input.languages)

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
  const importsByFile = new Map<string, readonly ImportEdge[]>()
  const fileContents = new Map<string, string>()
  const dynamicCallSites = new Set<string>()
  // Discovery's `languageExtensions` filter already narrowed the file list to
  // extensions the router recognizes. If `route()` still returns null here it means
  // the extension filter and the router disagree — the discovered file survived the
  // filter but the plugin dispatcher rejected it. That is a contract bug worth
  // recording rather than silently dropping.
  let terminalParseFailures = 0

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

    const sourceFile = await loadSourceFile(input.workspaceRoot, discoveredFile)

    const result = await runFilePipeline({
      file: sourceFile,
      language,
      frameworks: input.frameworks,
      effects: input.effects,
      registry: input.registry,
      config: input.config,
      dropCFilter,
      log: logger,
      ...(input.config.classifyTimeoutMs !== undefined
        ? { classifyTimeoutMs: input.config.classifyTimeoutMs }
        : {}),
      ...(input.config.parseTimeoutMs !== undefined
        ? { parseTimeoutMs: input.config.parseTimeoutMs }
        : {}),
    })

    // Reported for every file that got as far as a parse, abandoned or not: a file that
    // was slow *because* it was broken needs to say so, or the reader is sent to raise the
    // budget when the fix is the syntax.
    if (result.parseErrors.length > 0) {
      parseErrors.push({ file: discoveredFile.path, errors: result.parseErrors })
    }

    if (result.parseTimeout !== null) {
      const spent = Math.round(result.parseTimeout.elapsedMs)
      const budget = result.parseTimeout.budgetMs
      parseTimeouts.push(result.parseTimeout)
      additionalSkipped.push({
        path: discoveredFile.path,
        reason: "parse-timeout",
        detail: "extraction exceeded parseTimeoutMs",
      })
      logger.warn(
        `Skipped ${discoveredFile.path}: extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms). Override with config.parseTimeoutMs.`,
      )
      continue
    }

    // Held for LSP enrichment, and only for files that reached the IR: the pass builds one
    // document per file it has Symbols for, so a withdrawn file's text would never be read.
    fileContents.set(sourceFile.path, sourceFile.content)

    if (result.terminalParseFailure) terminalParseFailures++
    timeoutEvents.push(...result.timeoutEvents)
    symbols.push(...result.symbols)
    importsByFile.set(result.path, result.imports)
    for (const key of result.dynamicCallSites) dynamicCallSites.add(key)
  }

  symbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // Optional LSP enrichment pass (lsp-enrichment.md §2). Runs BEFORE call
  // resolution so the LSP tier's receiver / implementer hints can feed the
  // resolver. When `config.lsp?.enabled !== true` the pass is a total no-op
  // and returns the input unchanged; determinism (§10) is preserved because
  // the pass writes only to the strictly bounded set of fields in §5 and only
  // when its cache is fully populated first.
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
  enrichedSymbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // Call-resolution + symbol → symbol edge projection (call-resolution.md §7,
  // ir-schema.md §11). The resolver rewrites `Symbol.calls[].resolved` in
  // place and returns per-call-site CallEdges; those are then collapsed into
  // `(from, to, via: "call")` Dependency triples with a stable `(from, to, via)`
  // sort. LSP hints (when present) supply the §5.2 / §5.3 tier.
  const callGraph = resolveCallGraph({
    symbols: enrichedSymbols,
    importsByFile,
    receiverHints: enrichment.receiverHints,
    implementerHints: enrichment.implementerHints,
    dynamicCallSites,
  })
  const symbolEdges = projectSymbolEdges(callGraph.edges)

  // Transitive effect propagation over the resolved call graph
  // (effect-propagation.md §2). Runs AFTER call resolution and BEFORE the
  // logic-fingerprint recompute below; `api` and `syntax` axes do not read
  // `effects[]`, so only `logic` needs to be refreshed on the augmented
  // symbols (effect-propagation.md §8).
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
  const resolvedSymbols = propagatedSymbols

  // parsedFiles counts every file the pipeline successfully parsed. Files with
  // recoverable parse errors still count as parsed (a non-null tree survived); only
  // terminal parse failures (null tree) are excluded. `attempted` nets out both kinds of
  // `additionalSkipped`: an unroutable file never reaches the pipeline, and one over its
  // parse budget reaches it but withdraws — neither is a file the run parsed.
  const attempted = discovered.files.length - additionalSkipped.length
  const stats = buildStats({
    totalFiles: discovered.files.length + discovered.skipped.length,
    parsedFiles: attempted - terminalParseFailures,
    symbols: resolvedSymbols,
    timeoutEvents,
    propagation: propagation.stats,
    lspEnrichment: enrichment.stats,
    callResolution: callGraph.stats,
  })

  const workspace: IR["workspace"] = {
    root: ".",
    managers: [...(input.workspaceManagers ?? [])],
    // `languageId`, not `manifest.name`: the former is the `LanguageId` vocabulary this
    // field is typed with (and the prefix on every Symbol id), the latter is a plugin ref.
    languages: uniqueSorted(input.languages.map((l) => l.languageId)),
  }

  const ir: IR = {
    $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
    generator: {
      name: input.generator?.name ?? "@aburi/core",
      version: input.generator?.version ?? "0.0.0",
      plugins: buildPluginRefs(input),
    },
    workspace,
    components: sortComponents(input.components ?? []),
    symbols: resolvedSymbols,
    dependencies: symbolEdges,
    stats,
  }

  assertIRIntegrity(ir)

  const skipped = [...discovered.skipped, ...additionalSkipped].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  return {
    ir,
    parseErrors,
    skipped,
    timeoutEvents,
    parseTimeouts,
    unresolvedCalls: callGraph.diagnostics,
  }
}

/**
 * Serialize an IR to `<output-dir>/aburi.ir.json`. Uses `serializeCanonical` so the
 * output is byte-stable across runs — timestamps and unordered maps do not perturb it.
 */
export interface WriteCanonicalIROptions {
  /**
   * Match `SerializeOptions.format`. "pretty" (the default) matches `aburi scan`'s
   * standard on-disk layout; "compact" mirrors the `--compact` CLI flag.
   */
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

function collectLangDropPatterns(languages: readonly LanguagePlugin[]): string[] {
  const patterns: string[] = []
  for (const language of languages) {
    if (language.fileDropPatterns) patterns.push(...language.fileDropPatterns)
  }
  return patterns
}

async function loadSourceFile(
  workspaceRoot: string,
  discovered: DiscoveredFile,
): Promise<SourceFile> {
  const absolute = resolve(workspaceRoot, discovered.path)
  const content = await readFile(absolute, "utf8")
  return { path: discovered.path, content }
}

interface BuildStatsInput {
  totalFiles: number
  parsedFiles: number
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
    // Unconditional, like effectPropagation: a run with nothing to resolve
    // still reports the shape it observed, so a reviewer can tell "no
    // unresolved calls" apart from "this IR predates the counter".
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
  return stats
}

/**
 * Sort by id, and normalize the one Class A field on `Component` (`description`, per
 * `ir-schema.md` §1.1) to an explicit `null`.
 *
 * `ScanInput.components` is a public boundary: the in-tree CLI writes the key, but any other
 * `@aburi/core` caller can hand over a `Component` built against the read-side type, where
 * `description` is optional. Without this the scan would emit a document that breaks its own
 * convention, and — because `serializeCanonical` drops `undefined` properties — the omission
 * would be visible only in the written bytes. This is the same failure `WrittenSourceRange`
 * closes on the plugin boundary, on the one other Class A field that crosses a public API.
 */
function sortComponents(components: readonly Component[]): Component[] {
  return [...components]
    .map((c) => ({ ...c, description: c.description ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Collapse per-call-site `CallEdge[]` (`from`, `to`, `via`, `confidence`, `line`)
 * into deduplicated `Dependency` triples keyed on `(from, to, via)`. Multiple
 * calls from the same caller to the same callee become one Dependency — the
 * per-line detail lives on `Symbol.calls[]` and is deliberately not duplicated
 * onto Dependency (ir-schema.md §11). `direction` is fixed to `"outbound"`
 * (call edges are inherently directional) and `effect` to `null` (effect
 * annotation is a separate propagation pass — effect-propagation.md).
 */
function projectSymbolEdges(edges: readonly CallEdge[]): Dependency[] {
  const seen = new Set<string>()
  const out: Dependency[] = []
  for (const edge of edges) {
    const key = `${edge.from}\t${edge.to}\t${edge.via}`
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
  out.sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1
    if (a.to !== b.to) return a.to < b.to ? -1 : 1
    return a.via < b.via ? -1 : a.via > b.via ? 1 : 0
  })
  return out
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort()
}

function buildPluginRefs(input: ScanInput): PluginRef[] {
  const refs: PluginRef[] = []
  for (const plugin of input.languages)
    refs.push(buildPluginRef(plugin.manifest.name, "lang", plugin.manifest.version))
  for (const plugin of input.frameworks)
    refs.push(buildPluginRef(plugin.manifest.name, "framework", plugin.manifest.version))
  for (const plugin of input.effects)
    refs.push(buildPluginRef(plugin.manifest.name, "effects", plugin.manifest.version))
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return refs
}

/**
 * Placeholder grammar revision emitted for lang plugins that do not yet expose their
 * tree-sitter revision through the plugin surface. The schema (ir-schema §3.4) requires
 * a non-null value for `type: "lang"`; using a stable sentinel keeps IRs schema-valid
 * without pretending we know what revision produced them. Consumers can detect this
 * value and treat it as "pending" for cross-run comparability. A future patch that
 * teaches lang plugins to publish `grammarRevision` will thread it through here.
 */
const PENDING_GRAMMAR_REVISION = "pending@0.0.0"

function buildPluginRef(name: string, type: PluginRef["type"], version: string): PluginRef {
  return {
    name,
    type,
    version,
    grammarRevision: type === "lang" ? PENDING_GRAMMAR_REVISION : null,
  }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
