import { dirname, resolve } from "node:path"
import {
  type CollidingFile,
  CoreError,
  compareCodeUnit,
  countBy,
  describeCodePoints,
  detectComponents,
  detectManagers,
  groupBy,
  isStrict,
  languageFileDropPatterns,
  makeComponentId,
  makeLanguageId,
  posixWorkspaceRelativeViolation,
  type ScanResult,
  type SkippedFile,
  scan,
  serializeCanonical,
  type TreeReleaseFailure,
  type UndeclaredVocabOccurrence,
  type UnnameableFile,
  type UnrepresentableFile,
  type UnresolvedDeclaration,
} from "@aburi/core"
import {
  formatCallResolutionLine,
  projectComponent,
  projectWorkspace,
} from "@aburi/markdown-projection"
import type {
  CallResolutionStats,
  Component,
  Config,
  IR,
  LanguagePlugin,
  LspEnrichmentStats,
  ParseError,
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import {
  COMPONENTS_DIRNAME,
  IR_JSON_FILENAME,
  resolveOutputDir,
  WORKSPACE_MD_FILENAME,
} from "../artifact-paths"
import { loadPinnedConfig, type PinnedConfig, pinConfig } from "../config-load"
import type { LogLevel } from "../env"
import { assertNever, CliError, errorMessage, internalFault } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { readGeneratorInfo } from "../generator-info"
import { writeFullListing, writeListing } from "../listing"
import { createLogger } from "../logger"
import {
  createOutputDir,
  type OutputCommand,
  removeOutputFile,
  writeOutputFile,
} from "../output-file"
import { frameworkIdForPlugin } from "../plugin-catalog"
import { type LoadedPlugins, loadPlugins } from "../plugin-loader"
import { describeUnresolvedDeclarations } from "../unresolved-report"
import {
  type DiscoveredVocabItem,
  renderVocabDiscovered,
  summarizeUndeclaredVocab,
  VOCAB_DISCOVERED_FILENAME,
} from "../vocab-discovered"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"

export interface ScanOptions {
  cwd?: string
  command?: OutputCommand
  configPath?: string
  pinnedConfig?: PinnedConfig
  pluginRefRoot?: string
  outputDir?: string
  format?: "json" | "md" | "both"
  ignore?: readonly string[]
  respectGitignore?: boolean
  compact?: boolean
  suppressTimestamp?: boolean
  strict?: boolean
  lsp?: boolean
  logLevel?: LogLevel
  incidents?: {
    warn: WarnFn
    label?: string
  }
}

export type CoverageFault =
  | { kind: "nothing-discovered" }
  | {
      kind: "nothing-parsed"
      totalFiles: number
      dominant: SkippedFile["reason"]
      dominantCount: number
    }
  | { kind: "below-floor"; parsedFiles: number; totalFiles: number; floor: number }

export interface ScanReport {
  irPath: string | null
  workspaceMdPath: string | null
  componentMdPaths: string[]
  totalFiles: number
  /** Read off the Document rather than derived, so the CLI cannot disagree with it (integrity #21). */
  parsedFiles: number
  keptSymbols: number
  droppedSymbols: number
  parseErrorFiles: readonly { path: string; detail: string }[]
  /** How many files `parseErrorFiles` names. */
  parseErrorCount: number
  parseFailureCount: number
  timeoutCount: number
  /** Files that never made it into the IR; `@aburi/core` returns these rather than logging them. */
  skipped: readonly { path: string; reason: SkippedFile["reason"]; detail?: string }[]
  extractionFailures: readonly { file: string; message: string; code?: string }[]
  treeReleaseFailures: readonly TreeReleaseFailure[]
  /** Present when the LSP enrichment pass ran; absent when LSP was skipped entirely. */
  lspEnrichment: LspEnrichmentStats | undefined
  /** Head-side call-resolution census rendered for stdout (call-resolution.md). */
  callResolutionLine: string
  /** Per-call diagnostics behind that census, kept out of the IR (`call-resolution.md`). */
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  /** Absolute path of the config that was read, or `null` when the run fell through to autodetect. */
  configSource: string | null
  configPinnedByCaller: boolean
  /** Marker-detected root; the base for Symbol id paths and the config's relative globs. */
  workspaceRoot: string
  /** Why this scan's coverage is not worth believing, or `null`. `exitCode` is derived from it. */
  coverageFault: CoverageFault | null
  unrepresentableFiles: readonly UnrepresentableFile[]
  undeclaredVocab: readonly DiscoveredVocabItem[]
  /** Where the record of `undeclaredVocab` was written, or `null` when none was. */
  vocabDiscoveredPath: string | null
  /** Managers whose manifest declared package patterns and resolved none of them. Not a fault. */
  unresolvedDeclarations: readonly UnresolvedDeclaration[]
  /** Whether the whole repository was described as one Component because detection found no package. */
  fellBackToSingleComponent: boolean
  pluginNamedFrameworks: readonly PluginNamedFramework[]
  exitCode: ExitCode
}

export interface PluginNamedFramework {
  component: string
  /** As written in `components[].frameworks`. */
  value: string
  frameworkIds: readonly string[]
}

export async function runScan(options: ScanOptions = {}): Promise<ScanReport> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)

  const pinnedConfig = options.pinnedConfig ?? (await pinConfig(cwd, options.configPath))
  const loaded = await loadPinnedConfig(pinnedConfig)
  const config = mergeCliOverrides(loaded.config, options)

  const plugins = await loadPlugins({
    config,
    workspaceRoot,
    pluginRefRoot: options.pluginRefRoot ?? workspaceRoot,
    syntheticPlugins: loaded.syntheticPlugins,
  })
  requireLanguagePlugin(plugins.languages.length, loaded.source)

  const managers = await detectManagers(workspaceRoot)
  const components = await resolveComponents(config, workspaceRoot, plugins.languages)
  const fellBackToSingleComponent =
    declaredComponents(config) === undefined && managers.workspaces.length === 0

  const scanInput: Parameters<typeof scan>[0] = {
    workspaceRoot,
    config,
    languages: plugins.languages,
    frameworks: plugins.frameworks,
    effects: plugins.effects,
    registry: plugins.registry,
    workspaceManagers: managers.managers.map((manager) => ({
      tool: manager.tool,
      roots: [...manager.roots],
    })),
    components,
    generator: await readGeneratorInfo(),
    logger: createLogger(options.logLevel === undefined ? {} : { minimum: options.logLevel }),
  }
  const command = options.command ?? "scan"
  const outputDir = resolveOutputDir(cwd, options.outputDir, config.output?.dir)
  await createOutputDir(command, outputDir)
  let scanResult: Awaited<ReturnType<typeof scan>>
  try {
    scanResult = await scan(scanInput)
  } catch (error) {
    if (error instanceof CoreError && error.code === "vocab-undeclared") {
      throw new CliError(error.message, "plugin-error", { cause: error })
    }
    throw error
  }

  const format = options.format ?? "both"

  let irPath: string | null = null
  if (format !== "md") {
    irPath = resolve(outputDir, IR_JSON_FILENAME)
    let serialized: string
    try {
      serialized = serializeCanonical(scanResult.ir, {
        format: options.compact ? "compact" : "pretty",
      })
    } catch (error) {
      throw new CliError(
        `Failed to serialize the IR for ${irPath}: ${errorMessage(error)}`,
        "config-error",
        { cause: error },
      )
    }
    await writeOutputFile({ command, artefact: "the IR", path: irPath }, serialized)
  }
  const undeclaredVocab = summarizeUndeclaredVocab(requireUndeclaredVocab(scanResult))
  const withdrawnByParse = new Set(
    scanResult.skipped.filter((file) => file.reason === "parse-failed").map((file) => file.path),
  )

  const parseErrorFiles = scanResult.parseErrors
    .filter((record) => !withdrawnByParse.has(record.file))
    .map((record) => ({ path: record.file, detail: describeParseErrors(record.errors) }))

  const coverageFault = findCoverageFault(
    scanResult.ir.stats.totalFiles,
    scanResult.ir.stats.parsedFiles,
    scanResult.skipped,
    config.minParsedFileRatio,
  )

  const report: ScanReport = {
    irPath,
    // These three are filled in below, as each is written.
    workspaceMdPath: null,
    componentMdPaths: [],
    totalFiles: scanResult.ir.stats.totalFiles,
    parsedFiles: scanResult.ir.stats.parsedFiles,
    keptSymbols: scanResult.ir.stats.keptSymbols,
    droppedSymbols: scanResult.ir.stats.droppedSymbols,
    parseErrorFiles,
    parseErrorCount: parseErrorFiles.length,
    parseFailureCount: withdrawnByParse.size,
    timeoutCount: scanResult.timeoutEvents.length,
    skipped: scanResult.skipped.map((file) => {
      const entry: { path: string; reason: SkippedFile["reason"]; detail?: string } = {
        path: file.path,
        reason: file.reason,
      }
      if (file.detail !== undefined) entry.detail = file.detail
      return entry
    }),
    extractionFailures: scanResult.extractionFailures.map((failure) => ({ ...failure })),
    treeReleaseFailures: scanResult.treeReleaseFailures.map((failure) => ({ ...failure })),
    lspEnrichment: scanResult.ir.stats.lspEnrichment,
    callResolutionLine: formatCallResolutionLine(requireCallResolution(scanResult.ir)),
    unresolvedCalls: scanResult.unresolvedCalls,
    configSource: loaded.source,
    configPinnedByCaller: options.pinnedConfig !== undefined,
    workspaceRoot,
    coverageFault,
    unrepresentableFiles: scanResult.unrepresentableFiles.map((file) => ({ ...file })),
    undeclaredVocab,
    vocabDiscoveredPath: null,
    unresolvedDeclarations: managers.unresolved,
    fellBackToSingleComponent,
    pluginNamedFrameworks: pluginNamedFrameworks(config, plugins.registry),
    exitCode:
      scanResult.extractionFailures.length > 0 ||
      coverageFault !== null ||
      scanResult.unrepresentableFiles.length > 0
        ? EXIT.GATE
        : EXIT.SUCCESS,
  }
  try {
    report.workspaceMdPath = await maybeWriteWorkspaceMd(
      command,
      format,
      outputDir,
      scanResult.ir,
      options,
    )
    await maybeWriteComponentMd(command, format, outputDir, scanResult.ir, report.componentMdPaths)

    if (command === "scan") {
      const record = {
        command,
        artefact: "the discovered-vocabulary record",
        path: resolve(outputDir, VOCAB_DISCOVERED_FILENAME),
      }
      if (isStrict(config)) {
        await removeOutputFile(record)
      } else {
        await writeOutputFile(
          record,
          renderVocabDiscovered(
            undeclaredVocab,
            options.suppressTimestamp === true ? null : new Date().toISOString(),
          ),
        )
        report.vocabDiscoveredPath = record.path
      }
    }
  } catch (error) {
    reportIncidents(report, options.incidents)
    throw error
  }
  reportIncidents(report, options.incidents)
  return report
}

/** Hand the report to the incident sink, when the caller gave one. */
function reportIncidents(report: ScanReport, incidents: ScanOptions["incidents"]): void {
  if (incidents === undefined) return
  try {
    reportScanIncidents(report, incidents.warn, incidents.label ?? null)
  } catch {
  }
}

const REASON_REPORT: Record<SkippedFile["reason"], { rank: number; advice: string }> = {
  "over-size": {
    rank: 1,
    advice: "larger than maxFileSizeBytes. Raise the budget, or leave them out with ignore.",
  },
  unreadable: {
    rank: 2,
    advice:
      "they stopped being files while the scan ran, so something changed the tree under it — re-run. A read that failed for any other reason ends the run rather than landing here.",
  },
  unroutable: {
    rank: 3,
    advice:
      "no route into the IR exists for them, decided before any of them was read. Discovery accepted an extension no plugin claims — a bug in the plugin set — or a path segment holds a Symbol id separator, and renaming that segment is the fix. Each detail says which.",
  },
  "parse-failed": {
    rank: 4,
    advice: "the language plugin refused the source. Deterministic: fix the file, or the plugin.",
  },
  "parse-timeout": {
    rank: 5,
    advice:
      "extraction ran past parseTimeoutMs. Machine-dependent: re-run, and raise the budget if it repeats.",
  },
  "extraction-failed": {
    rank: 6,
    advice:
      "a plugin threw while extracting, or its Symbols could not enter the Document. This is the reason the run does not exit clean.",
  },
}

function describeParseErrors(errors: readonly ParseError[]): string {
  const first = errors[0]
  if (first === undefined) return "parse errors reported without detail"
  const where = `${first.line}:${first.column} — ${first.message}`
  return errors.length === 1 ? where : `${errors.length} errors, first at ${where}`
}

/** A line that stands on its own: `⚠`, the scan's label when one was given, then the text. */
type SayIncident = (line: string) => void

export function reportScanIncidents(report: ScanReport, warn: WarnFn, label: string | null): void {
  const sayIncident: SayIncident = (line) => {
    warn(label === null ? `⚠ ${line}` : `⚠ ${label}: ${line}`)
  }
  for (const line of describeUnresolvedDeclarations(
    report.unresolvedDeclarations,
    report.fellBackToSingleComponent,
  )) {
    sayIncident(line)
  }
  reportCoverageFault(report.coverageFault, sayIncident)
  reportPluginNamedFrameworks(report.pluginNamedFrameworks, sayIncident)
  reportUnrepresentable(report.unrepresentableFiles, sayIncident, warn)
  reportTreeReleaseFailures(report.treeReleaseFailures, sayIncident, warn)
  reportUndeclaredVocab(report.undeclaredVocab, report.vocabDiscoveredPath, sayIncident, warn)
  reportParseErrors(report.parseErrorFiles, sayIncident, warn)
  reportConfigOutsideWorkspaceRoot(report, sayIncident)
  if (report.parseFailureCount > 0) {
    sayIncident(
      `${report.parseFailureCount} file(s) could not be parsed and were left out of the IR.`,
    )
  }
  if (report.timeoutCount > 0) {
    sayIncident(`${report.timeoutCount} effect classification(s) hit the per-call timeout budget.`)
  }
  reportSkipped(report.skipped, sayIncident, warn)
  const lsp = report.lspEnrichment
  if (lsp !== undefined) {
    if (lsp.filesFellBack > 0) {
      sayIncident(
        `LSP enrichment fell back for ${lsp.filesFellBack} file(s); IR field values in those files remain at the untyped tier.`,
      )
    }
    if (lsp.languagesDisabled.length > 0) {
      sayIncident(`LSP disabled mid-run for language(s): ${lsp.languagesDisabled.join(", ")}.`)
    }
    if (lsp.requestsTimedOut > 0 || lsp.requestsFailed > 0) {
      // Its own line, with its own condition: it fires when neither of the two above did.
      sayIncident(
        `LSP requests: ${lsp.requestsIssued} issued · ${lsp.requestsTimedOut} timed out · ${lsp.requestsFailed} failed.`,
      )
    }
    reportHints(lsp, sayIncident)
  }
}

function reportHints(lsp: LspEnrichmentStats, sayIncident: SayIncident): void {
  const produced = lsp.hintsProduced ?? 0
  const rejected = lsp.hintsRejected
  const refused =
    rejected === undefined
      ? 0
      : rejected.unparseableHover +
        rejected.ownerClassNotFound +
        rejected.memberNotFound +
        rejected.kindMismatch +
        rejected.targetDropped
  if (produced === 0 && refused === 0) return
  sayIncident(
    `LSP receiver hints: ${produced} produced · ${lsp.hintsConsumed ?? 0} resolved a call · ${refused} rejected.`,
  )
}

function reportParseErrors(
  files: ScanReport["parseErrorFiles"],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (files.length === 0) return
  sayIncident(`${files.length} file(s) had recoverable parse errors.`)
  writeFullListing(
    files.map((file) => `${file.path}: ${file.detail}`),
    writeDetail,
  )
}

function reportTreeReleaseFailures(
  failures: ScanReport["treeReleaseFailures"],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (failures.length === 0) return
  sayIncident(
    `${failures.length} parse tree(s) were not released by the plugin that built them. ` +
      `A tree a plugin does not free is not reclaimed by the garbage collector, so a long ` +
      `enough run exhausts the parser's heap.`,
  )
  for (const [plugin, group] of groupBy(failures, (failure) => failure.plugin)) {
    const first = group[0]
    if (first === undefined) continue
    writeDetail(`    ${plugin} (${group.length}) — ${first.file}: ${first.detail}`)
  }
}

function reportUndeclaredVocab(
  items: ScanReport["undeclaredVocab"],
  recordPath: string | null,
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (items.length === 0) return
  const record = recordPath === null ? "" : ` Recorded in ${recordPath}.`
  sayIncident(
    `${items.length} value(s) were emitted that the emitting plugin's manifest does not declare; ` +
      `strict is off, so the scan kept them.${record}`,
  )
  for (const item of items) {
    writeDetail(`    ${item.kind} ${item.value} — ${item.firstSeenBy} (${item.occurrences})`)
  }
}

function reportCoverageFault(fault: CoverageFault | null, sayIncident: SayIncident): void {
  if (fault === null) return
  const consequence = "The IR is empty and will diff clean against any other empty IR."
  if (fault.kind === "nothing-discovered") {
    sayIncident(
      `No file was discovered to scan. ${consequence} Check ignore and .gitignore, ` +
        "components[].roots, and whether a loaded language plugin claims any extension in this workspace.",
    )
    return
  }
  if (fault.kind === "nothing-parsed") {
    sayIncident(
      `${fault.totalFiles} file(s) discovered, 0 parsed — ${fault.dominantCount} as ` +
        `${fault.dominant}. ${consequence}`,
    )
    return
  }
  const percent = Math.floor((fault.parsedFiles / fault.totalFiles) * 100)
  sayIncident(
    `${fault.parsedFiles} of ${fault.totalFiles} file(s) parsed (${percent}%), below the ` +
      `minParsedFileRatio floor of ${Math.ceil(fault.floor * 100)}%. ` +
      "Raise the coverage, or lower the floor if this is what the workspace looks like now.",
  )
}

function reportPluginNamedFrameworks(
  found: ScanReport["pluginNamedFrameworks"],
  sayIncident: SayIncident,
): void {
  for (const { component, value, frameworkIds } of found) {
    const fix =
      frameworkIds.length === 0
        ? "That plugin provides no framework: remove it, or write the framework id the component is built on."
        : `Write ${frameworkIds.map((id) => `"${id}"`).join(" or ")}.`
    sayIncident(
      `Component "${component}" lists "${value}" in frameworks, which names a plugin, not a framework; the IR carries it as written. ${fix}`,
    )
  }
}

function reportConfigOutsideWorkspaceRoot(report: ScanReport, sayIncident: SayIncident): void {
  if (report.configSource === null) return
  if (report.configPinnedByCaller) return
  if (dirname(report.configSource) === report.workspaceRoot) return
  sayIncident(
    `Config ${report.configSource} sits below the workspace root ${report.workspaceRoot}. ` +
      `Paths inside it (ignore, components[].roots, relative plugin refs) resolve against the root, ` +
      `and the scan covers the whole workspace.`,
  )
}

function reportSkipped(
  skipped: ScanReport["skipped"],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (skipped.length === 0) return
  const groups = [...groupBy(skipped, (file) => file.reason)].sort(
    ([a], [b]) => REASON_REPORT[a].rank - REASON_REPORT[b].rank,
  )
  const census = groups.map(([reason, files]) => `${reason}=${files.length}`).join(", ")
  sayIncident(`${skipped.length} file(s) contributed no Symbols: ${census}`)
  for (const [reason, files] of groups) {
    sayIncident(`${reason} (${files.length}) — ${REASON_REPORT[reason].advice}`)
    writeListing(
      files.map((file) => {
        // Empty as well as absent: a caller-assembled report may say nothing, and `src/x.ts: `
        // is a path, a colon, and silence.
        const detail = file.detail ?? ""
        return detail.length === 0 ? file.path : `${file.path}: ${detail}`
      }),
      writeDetail,
    )
  }
}

function reportUnrepresentable(
  files: ScanReport["unrepresentableFiles"],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  const unspellable: UnnameableFile[] = []
  const colliding: CollidingFile[] = []
  for (const file of files) {
    switch (file.reason) {
      case "unspellable-name":
        unspellable.push(file)
        break
      case "colliding-spelling":
        colliding.push(file)
        break
      default:
        assertNever(
          file,
          "unrepresentable-file reason from @aburi/core, which this CLI has no section for",
        )
    }
  }
  reportUnspellable(unspellable, sayIncident, writeDetail)
  reportColliding(colliding, sayIncident, writeDetail)
}

/** One section per cause, because the fix differs and the two are told apart by nothing else. */
function reportUnspellable(
  files: readonly UnnameableFile[],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (files.length === 0) return
  const byPrefix = groupByKeyOrder(files, (file) => file.unnameablePrefix)
  sayIncident(
    `${files.length} file(s) were left out of the IR and out of its counts, under ${byPrefix.size} name(s) with no spelling here: "/" is the only separator a Document path has, so a name holding a backslash cannot be written down at all. Rename each one below. To leave one out with ignore instead, write its backslash twice — a glob pattern spends a single one as an escape, so the name as printed does not match itself.`,
  )
  for (const [prefix, group] of byPrefix) {
    writeDetail(
      group[0]?.fsPath === prefix
        ? `    ${prefix}`
        : `    ${prefix} — a directory, and the ${group.length} file(s) under it`,
    )
  }
}

function reportColliding(
  files: readonly CollidingFile[],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (files.length === 0) return
  const byPath = groupByKeyOrder(files, (file) => file.documentPath)
  sayIncident(
    `${files.length} file(s) were left out of the IR and out of its counts, on ${byPath.size} path(s) more than one name claims: the Document holds every string in Unicode NFC, and these names differ only in how they are composed, so normalizing them gives one path for several files. Rename all but one of each group. ignore matches the spelling on disk, so the path below excludes whichever claimant is spelled that way and leaves the rest of the group scannable, while a wildcard over it excludes them all.`,
  )
  for (const [documentPath, group] of byPath) {
    writeDetail(`    ${documentPath} — claimed by ${group.length} file(s) on disk:`)
    for (const file of group) writeDetail(`        ${describeCodePoints(file.fsPath)}`)
  }
}

/** `groupBy` ordered by key, so the paragraph is the same paragraph on every run. */
function groupByKeyOrder<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  return new Map([...groupBy(items, key)].sort(([a], [b]) => compareCodeUnit(a, b)))
}

function findCoverageFault(
  totalFiles: number,
  parsedFiles: number,
  skipped: readonly { reason: SkippedFile["reason"] }[],
  floor: number | undefined,
): CoverageFault | null {
  if (parsedFiles === 0) {
    const dominant = dominantReason(skipped)
    return dominant === null
      ? { kind: "nothing-discovered" }
      : {
          kind: "nothing-parsed",
          totalFiles,
          dominant: dominant.reason,
          dominantCount: dominant.count,
        }
  }
  if (floor === undefined) return null
  if (parsedFiles / totalFiles < floor) {
    return { kind: "below-floor", parsedFiles, totalFiles, floor }
  }
  return null
}

function dominantReason(
  skipped: readonly { reason: SkippedFile["reason"] }[],
): { reason: SkippedFile["reason"]; count: number } | null {
  const counts = countBy(skipped, (file) => file.reason)
  let best: { reason: SkippedFile["reason"]; count: number } | null = null
  for (const [reason, count] of counts) {
    if (best === null || count > best.count) {
      best = { reason, count }
      continue
    }
    if (count === best.count && REASON_REPORT[reason].rank < REASON_REPORT[best.reason].rank) {
      best = { reason, count }
    }
  }
  return best
}

function requireUndeclaredVocab(result: ScanResult): readonly UndeclaredVocabOccurrence[] {
  const occurrences: readonly UndeclaredVocabOccurrence[] | undefined = result.undeclaredVocab
  if (occurrences === undefined) {
    throw new CliError(
      "scan() returned no undeclaredVocab; @aburi/core is older than this @aburi/cli and does not report the vocabulary a scan with strict off kept (extension-vocab.md).",
      "runtime-error",
    )
  }
  return occurrences
}

function requireCallResolution(ir: IR): CallResolutionStats {
  const stats = ir.stats.callResolution
  if (stats === undefined) {
    throw new CliError(
      "scan() returned an IR without stats.callResolution; @aburi/core stopped emitting the call-resolution census (call-resolution.md).",
      "runtime-error",
    )
  }
  return stats
}

function requireLanguagePlugin(count: number, configSource: string | null): void {
  if (count > 0) return
  const where = configSource === null ? "no aburi.json was found" : `config: ${configSource}`
  throw new CliError(
    `No language plugin is configured (${where}), so no source file can be parsed. Add one ` +
      `to "languages" in aburi.json — e.g. "lang-typescript" — or run \`aburi init\`.`,
    "config-error",
  )
}

function mergeCliOverrides(config: Partial<Config>, options: ScanOptions): Config {
  const merged: Partial<Config> = { ...config }
  if (options.ignore !== undefined && options.ignore.length > 0) {
    merged.ignore = [...(merged.ignore ?? []), ...options.ignore]
  }
  if (options.respectGitignore !== undefined) merged.respectGitignore = options.respectGitignore
  if (options.strict !== undefined) merged.strict = options.strict
  if (options.lsp !== undefined) {
    merged.lsp = { ...(merged.lsp ?? {}), enabled: options.lsp }
  }
  return merged as Config
}

function assertWorkspaceRelative(root: string, componentId: string): string {
  const normalized = root.normalize("NFC")
  const violation = posixWorkspaceRelativeViolation(
    normalized,
    `components[id=${componentId}] root`,
  )
  if (violation !== null) throw new CoreError(violation.message, violation)
  return normalized
}

function pluginNamedFrameworks(
  config: Partial<Config>,
  registry: LoadedPlugins["registry"],
): PluginNamedFramework[] {
  const found: PluginNamedFramework[] = []
  for (const component of declaredComponents(config) ?? []) {
    for (const value of component.frameworks ?? []) {
      if (registry.findFramework(value) !== null) continue
      const manifest = registry.listPlugins().find((plugin) => plugin.name === value)
      const firstParty = frameworkIdForPlugin(value)
      if (manifest !== undefined) {
        found.push({
          component: component.id,
          value,
          frameworkIds: [...manifest.provides.frameworks],
        })
      } else if (firstParty !== undefined) {
        found.push({ component: component.id, value, frameworkIds: [firstParty] })
      }
    }
  }
  return found
}

function declaredComponents(config: Partial<Config>): Config["components"] | undefined {
  const declared = config.components
  return declared !== undefined && declared.length > 0 ? declared : undefined
}

async function resolveComponents(
  config: Partial<Config>,
  workspaceRoot: string,
  languages: readonly LanguagePlugin[],
): Promise<Component[]> {
  const declared = declaredComponents(config)
  try {
    if (declared !== undefined) {
      return declared.map((entry) => {
        const languages = (entry.languages ?? []).map(makeLanguageId)
        const component: Component = {
          id: makeComponentId(entry.id),
          name: entry.name ?? entry.id,
          roots: entry.roots.map((root) => assertWorkspaceRelative(root, entry.id)),
          languages: languages.length > 0 ? languages : [makeLanguageId("ts")],
          description: entry.description ?? null,
        }
        if (entry.publicApi !== undefined && entry.publicApi.length > 0) {
          component.publicApi = entry.publicApi.map((pattern) => pattern.normalize("NFC"))
        }
        if (entry.frameworks !== undefined && entry.frameworks.length > 0) {
          component.frameworks = [...entry.frameworks]
        }
        return component
      })
    }
    return await detectComponents({
      workspaceRoot,
      ignore: [...(config.ignore ?? []), ...languageFileDropPatterns(languages)],
      ...(config.respectGitignore === undefined
        ? {}
        : { respectGitignore: config.respectGitignore }),
    })
  } catch (error) {
    throw componentResolutionFailure(error)
  }
}

function componentResolutionFailure(error: unknown): CliError {
  const configFault = error instanceof CoreError && CONFIG_COMPONENT_ERROR_CODES.has(error.code)
  return new CliError(
    `Failed to resolve components: ${errorMessage(error)}`,
    configFault ? "config-error" : "runtime-error",
    { cause: error },
  )
}

const CONFIG_COMPONENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid-component-id",
  "invalid-language-id",
  "non-posix-path",
  "workspace-manifest-malformed",
  "workspace-root-outside",
])

async function maybeWriteWorkspaceMd(
  command: OutputCommand,
  format: "json" | "md" | "both",
  outputDir: string,
  ir: IR,
  options: ScanOptions,
): Promise<string | null> {
  if (format === "json") return null
  const path = resolve(outputDir, WORKSPACE_MD_FILENAME)
  const artefact = "the workspace Markdown"
  const md = renderPage(artefact, () =>
    projectWorkspace(ir, { suppressTimestamp: options.suppressTimestamp ?? false }),
  )
  await writeOutputFile({ command, artefact, path }, md)
  return path
}

async function maybeWriteComponentMd(
  command: OutputCommand,
  format: "json" | "md" | "both",
  outputDir: string,
  ir: IR,
  written: string[],
): Promise<void> {
  if (format === "json") return
  for (const component of ir.components) {
    const symbolsInComponent = ir.symbols.filter((symbol) => symbol.component === component.id)
    const artefact = `the Markdown for component "${component.id}"`
    const md = renderPage(artefact, () =>
      projectComponent({
        component,
        symbols: symbolsInComponent,
        dependencies: ir.dependencies,
      }),
    )
    const path = resolve(outputDir, COMPONENTS_DIRNAME, `${component.id}.md`)
    await writeOutputFile({ command, artefact, path }, md)
    written.push(path)
  }
}

function renderPage(artefact: string, render: () => string): string {
  try {
    return render()
  } catch (error) {
    throw internalFault(` while rendering ${artefact}`, errorMessage(error), error)
  }
}
