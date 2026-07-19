import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type {
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
  ParseError,
  PluginRef,
  SourceFile,
  Stats,
  VocabRegistry,
  WorkspaceManager,
} from "@aburi/types"
import { type CallEdge, resolveCallGraph } from "../callgraph"
import { serializeCanonical } from "../canonical"
import { CoreError } from "../errors"
import { logicFingerprint } from "../fingerprint"
import { assertIRIntegrity } from "../integrity"
import { type PropagationStats, propagateEffects } from "../propagate"
import { type DiscoveredFile, discoverFiles, type SkippedFile } from "./discover"
import { buildDropCFilter } from "./drop-c"
import { runFilePipeline } from "./pipeline"
import { buildLanguageRouter } from "./route"
import type { ClassifyTimeoutEvent } from "./timeout"

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
}

export interface ScanResult {
  ir: IR
  parseErrors: readonly ParseErrorRecord[]
  /** Files skipped during discovery (over-size, unreadable). Surfaced separately from parseErrors. */
  skipped: readonly SkippedFile[]
  /** Rich timeout observations for logging / CI signals. Aggregated into `ir.stats` too. */
  timeoutEvents: readonly ClassifyTimeoutEvent[]
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
 *   5. `assertIRIntegrity` — the 14 invariants must pass before we hand the IR back.
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
  const importsByFile = new Map<string, readonly ImportEdge[]>()
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
    })

    if (result.parseErrors.length > 0) {
      parseErrors.push({ file: discoveredFile.path, errors: result.parseErrors })
    }
    if (result.terminalParseFailure) terminalParseFailures++
    timeoutEvents.push(...result.timeoutEvents)
    symbols.push(...result.symbols)
    importsByFile.set(result.path, result.imports)
  }

  symbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // Call-resolution + symbol → symbol edge projection (call-resolution.md §7,
  // ir-schema.md §11). The resolver rewrites `Symbol.calls[].resolved` in
  // place and returns per-call-site CallEdges; those are then collapsed into
  // `(from, to, via: "call")` Dependency triples with a stable `(from, to, via)`
  // sort. Higher-tier resolution (component / workspace / LSP) will hook into
  // the same seam without disturbing this projection.
  const callGraph = resolveCallGraph({ symbols, importsByFile })
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
  // terminal parse failures (null tree) are excluded. Unroutable files never reach
  // the pipeline and are recorded on `skipped` instead.
  const attempted = discovered.files.length - additionalSkipped.length
  const stats = buildStats({
    totalFiles: discovered.files.length + discovered.skipped.length,
    parsedFiles: attempted - terminalParseFailures,
    symbols: resolvedSymbols,
    timeoutEvents,
    propagation: propagation.stats,
  })

  const workspace: IR["workspace"] = {
    root: ".",
    managers: [...(input.workspaceManagers ?? [])],
    languages: uniqueSorted(input.languages.map((l) => l.manifest.name)),
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
  return { ir, parseErrors, skipped, timeoutEvents }
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
  return stats
}

function sortComponents(components: readonly Component[]): Component[] {
  return [...components].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
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

function uniqueSorted(values: readonly string[]): string[] {
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
