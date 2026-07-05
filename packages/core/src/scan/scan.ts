import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type {
  Component,
  Config,
  Dependency,
  EffectClassifyTimeout,
  EffectPlugin,
  FrameworkPlugin,
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
import { serializeCanonical } from "../canonical"
import { assertIRIntegrity } from "../integrity"
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
 * Top-level scan orchestration. Delivers WI-11's ACs end-to-end:
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
 *   5. `assertIRIntegrity` — the 11 invariants must pass before we hand the IR back.
 *
 * Serialization to disk is the caller's job (`writeCanonicalIR` handles the canonical
 * JSON write). Keeping serialization off the scan path lets tests assert on the IR
 * object directly without touching the filesystem.
 */
export async function scan(input: ScanInput): Promise<ScanResult> {
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
  const symbolIdsByFile = new Map<string, string[]>()

  for (const discoveredFile of discovered.files) {
    const language = router.route(discoveredFile.path)
    if (language === null) continue

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
    timeoutEvents.push(...result.timeoutEvents)
    symbols.push(...result.symbols)
    symbolIdsByFile.set(
      discoveredFile.path,
      result.symbols.map((s) => s.id),
    )
  }

  symbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const stats = buildStats({
    totalFiles: discovered.files.length + discovered.skipped.length,
    parsedFiles: discovered.files.length - parseErrors.length,
    symbols,
    timeoutEvents,
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
    symbols,
    dependencies: [] as Dependency[],
    stats,
  }

  assertIRIntegrity(ir)

  return { ir, parseErrors, skipped: discovered.skipped, timeoutEvents }
}

/**
 * Serialize an IR to `<output-dir>/aburi.ir.json`. Uses `serializeCanonical` so the
 * output is byte-stable across runs — timestamps and unordered maps do not perturb it.
 */
export async function writeCanonicalIR(
  ir: IR,
  outputPath: string,
  options: { pretty?: boolean } = {},
): Promise<string> {
  const serialized = serializeCanonical(ir, {
    format: options.pretty === false ? "compact" : "pretty",
  })
  const { writeFile, mkdir } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serialized, "utf8")
  return serialized
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
}

function buildStats(input: BuildStatsInput): Stats {
  const kept = input.symbols.filter((s) => !s.dropped).length
  const dropped = input.symbols.length - kept
  const stats: Stats = {
    totalFiles: input.totalFiles,
    parsedFiles: input.parsedFiles,
    keptSymbols: kept,
    droppedSymbols: dropped,
  }
  if (input.timeoutEvents.length > 0) {
    stats.effectClassifyTimeouts = input.timeoutEvents.map(
      (event): EffectClassifyTimeout => ({
        plugin: event.plugin,
        symbolId: `${event.plugin}#${event.target}@${event.file}:${event.line}`,
        timeoutMs: Math.round(event.elapsedMs),
      }),
    )
  }
  return stats
}

function sortComponents(components: readonly Component[]): Component[] {
  return [...components].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
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

function buildPluginRef(name: string, type: PluginRef["type"], version: string): PluginRef {
  return { name, type, version, grammarRevision: type === "lang" ? null : null }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
