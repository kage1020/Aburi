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
  languageFileDropPatterns,
  makeComponentId,
  makeLanguageId,
  posixWorkspaceRelativeViolation,
  type SkippedFile,
  scan,
  serializeCanonical,
  type TreeReleaseFailure,
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
import { assertNever, CliError, errorMessage } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { readGeneratorInfo } from "../generator-info"
import { writeFullListing, writeListing } from "../listing"
import { createLogger } from "../logger"
import { createOutputDir, type OutputCommand, writeOutputFile } from "../output-file"
import { loadPlugins } from "../plugin-loader"
import { describeUnresolvedDeclarations } from "../unresolved-report"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"

export interface ScanOptions {
  cwd?: string
  /**
   * The command this scan runs under, which is what a failed write names: `aburi diff` runs
   * two scans and `aburi explain` one, and a reader who typed either must not be told that
   * `aburi scan` failed. Defaults to `"scan"`.
   */
  command?: OutputCommand
  configPath?: string
  /**
   * A config already decided by the caller, which supersedes both `configPath` and discovery.
   * `aburi diff` sets it so its base scan, running inside a temporary worktree, reads the
   * head's config — step 3 of the ref-form Behavior `cli-spec.md` gives `aburi diff`.
   * `{ kind: "autodetect" }` is meaningful rather than equivalent to omitting the field: the
   * caller looked and found nothing.
   */
  pinnedConfig?: PinnedConfig
  /**
   * Where a relative plugin ref (`./plugins/x.mjs`) in the config resolves from. Defaults to
   * this scan's own workspace root; `aburi diff`'s base scan passes the head's, since `cli-spec.md`
   * pins the plugin set to the head environment.
   */
  pluginRefRoot?: string
  outputDir?: string
  format?: "json" | "md" | "both"
  ignore?: readonly string[]
  /**
   * Override for `Config.respectGitignore`. `true` from `--respect-gitignore`, `false` from
   * `--no-respect-gitignore`, absent when neither was typed — the only value that leaves the
   * config's own answer standing.
   */
  respectGitignore?: boolean
  compact?: boolean
  suppressTimestamp?: boolean
  strict?: boolean
  /**
   * Override for `Config.lsp.enabled` (`--lsp` / `--no-lsp`); `undefined` falls through to
   * the config, per `docs/design/config.md`.
   */
  lsp?: boolean
  /**
   * Lowest level the run's `Logger` emits, from `ABURI_LOG_LEVEL` (`cli-spec.md`). Defaults to
   * `"warn"`.
   */
  logLevel?: LogLevel
  /**
   * Where this scan's incident report goes (`cli-spec.md`). Omit it and the report goes nowhere
   * — but not silent: the run's per-file `Logger` is a separate channel that still defaults to
   * `process.stderr`. One option rather than two because a label means nothing without a sink.
   */
  incidents?: {
    warn: WarnFn
    /**
     * Names this scan in its own lines — `base ref "main"`, `head (working tree)` — for a
     * command that runs two scans, where the same incident means different things at each.
     */
    label?: string
  }
}

/**
 * A scan that read too little of the workspace to be worth believing. Dangerous because it is
 * a *success*: an IR with no Symbols diffs against another one as `+0 -0 ~0`, so every
 * `--fail-on` gate downstream passes.
 *
 * Three kinds because the first move differs: nothing discovered points at the config, nothing
 * parsed at whatever withdrew the files (hence the dominant reason), below the floor at a
 * policy the workspace opted into.
 */
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
  /**
   * Files carrying parse errors the plugin called recoverable — every file on
   * `ScanResult.parseErrors` except the ones withdrawn *for* a parse error (`parseFailureCount`).
   * A file abandoned on its `parseTimeoutMs` budget is counted here (`lang-plugin.md`).
   *
   * Mostly these files are in the IR, and then nothing in the artifact names them: that is
   * what makes this list the run's only account of *which* files they were. The exception is
   * the timed-out file just mentioned. It is withdrawn, so `stats.skippedFiles[]` names it
   * under `parse-timeout` — with the clock rather than the errors — and it is named on both
   * lines. A file withdrawn for a duplicate Symbol id is the same shape: its extraction ran to
   * a result, so the parse errors it carries are real observations about the file and are kept.
   * A file a plugin *threw* on is the one case that is not here at all — the result never
   * materialized, so there was nothing to carry its parse errors (`core/scan/scan.ts`).
   *
   * `parseErrorCount` is set from this list's length where the report is built. Nothing in the
   * type holds them together, so a second construction site would have to do the same.
   */
  parseErrorFiles: readonly { path: string; detail: string }[]
  /** How many files `parseErrorFiles` names. */
  parseErrorCount: number
  /**
   * Files withdrawn because the parse produced nothing usable; the same files appear in
   * `skipped` as `parse-failed`. Does not move the exit code: unparseable source is a fact
   * about the workspace, not about the plugin set.
   */
  parseFailureCount: number
  timeoutCount: number
  /** Files that never made it into the IR; `@aburi/core` returns these rather than logging them. */
  skipped: readonly { path: string; reason: SkippedFile["reason"]; detail?: string }[]
  /**
   * Files withdrawn during extraction — a plugin threw, or the file's Symbols could not enter
   * the Document. Also in `skipped` as `extraction-failed` with the same message; what is only
   * here is the `code`, and this is the one skip reason that moves the exit code.
   */
  extractionFailures: readonly { file: string; message: string; code?: string }[]
  /**
   * Parse trees a language plugin was asked to free and did not. Reported, not gated: the
   * files are in the IR, and the cost is a leak that ends a long enough run out of heap.
   */
  treeReleaseFailures: readonly TreeReleaseFailure[]
  /** Present when the LSP enrichment pass ran; absent when LSP was skipped entirely. */
  lspEnrichment: LspEnrichmentStats | undefined
  /** Head-side call-resolution census rendered for stdout (call-resolution.md). */
  callResolutionLine: string
  /** Per-call diagnostics behind that census, kept out of the IR (`call-resolution.md`). */
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  /** Absolute path of the config that was read, or `null` when the run fell through to autodetect. */
  configSource: string | null
  /**
   * Whether `configSource` was decided by the caller rather than found from `cwd`, which
   * exempts it from `reportConfigOutsideWorkspaceRoot`.
   */
  configPinnedByCaller: boolean
  /** Marker-detected root; the base for Symbol id paths and the config's relative globs. */
  workspaceRoot: string
  /** Why this scan's coverage is not worth believing, or `null`. `exitCode` is derived from it. */
  coverageFault: CoverageFault | null
  /**
   * Candidate files the Document has no way to name (`cli-spec.md`), in path order. Nothing in the
   * artifact mentions them, so this list is the run's only account and moves the exit code.
   */
  unrepresentableFiles: readonly UnrepresentableFile[]
  /** Managers whose manifest declared package patterns and resolved none of them. Not a fault. */
  unresolvedDeclarations: readonly UnresolvedDeclaration[]
  /** Whether the whole repository was described as one Component because detection found no package. */
  fellBackToSingleComponent: boolean
  exitCode: ExitCode
}

/**
 * `cli-spec.md` — `aburi scan`. Resolves config, loads plugins, runs `@aburi/core` `scan`, then
 * writes IR JSON and per-Component Markdown into `--output-dir` (default `out/`).
 *
 * Writes nothing to the process streams of its own accord: summaries are the CLI wrapper's
 * to print, and the incident report goes to `options.incidents.warn` if a caller supplied one.
 */
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
  // Ahead of the scan: a destination that cannot hold the outputs is refused before the
  // workspace is read for them.
  const command = options.command ?? "scan"
  const outputDir = resolveOutputDir(cwd, options.outputDir, config.output?.dir)
  await createOutputDir(command, outputDir)
  const scanResult = await scan(scanInput)

  const format = options.format ?? "both"

  let irPath: string | null = null
  const workspaceMdPath = await maybeWriteWorkspaceMd(
    command,
    format,
    outputDir,
    scanResult.ir,
    options,
  )
  const componentMdPaths = await maybeWriteComponentMd(command, format, outputDir, scanResult.ir)
  if (format !== "md") {
    irPath = resolve(outputDir, IR_JSON_FILENAME)
    // Serialization can refuse the document (two keys differing only in Unicode composition),
    // which is a property of the scanned project — exit 2, with the target path attached. The
    // write is a separate step so that a disk refusing the bytes is reported as what it is
    // (exit 1, the command and the artefact named) rather than as a fault in the project.
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

  // A withdrawn file's parse errors are still reported — they are the account of why it was
  // withdrawn — so the two counts below would otherwise both include it, and one of them
  // would call its errors recoverable.
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
    workspaceMdPath,
    componentMdPaths,
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
    unresolvedDeclarations: managers.unresolved,
    fellBackToSingleComponent,
    // Three gates (`cli-spec.md`: exit codes, coverage, unnameable files), none of which
    // withholds the artifact: an extraction fault says the run is broken, a coverage fault says
    // it described nothing (or too little, under `minParsedFileRatio`), and an unnameable file
    // is source the artifact holds no trace of.
    exitCode:
      scanResult.extractionFailures.length > 0 ||
      coverageFault !== null ||
      scanResult.unrepresentableFiles.length > 0
        ? EXIT.GATE
        : EXIT.SUCCESS,
  }
  const incidents = options.incidents
  if (incidents !== undefined) {
    try {
      reportScanIncidents(report, incidents.warn, incidents.label ?? null)
    } catch {
      // The report is complete and the IR is on disk, so the exit code must not depend on
      // whether the sink survived (`aburi scan 2>&1 | head -1` closes it). The rest of the
      // report is lost with it; there is nowhere to report the reporting channel's failure.
    }
  }
  return report
}

/**
 * Where each reason sits in the report, and what to do about it.
 *
 * `rank` fixes the order the census and its groups come out in (the schema's `reason` enum
 * order) so it is not a function of where in the workspace the losses sat; the ranks must
 * stay distinct, because `sort` is stable and a tie would fall back to scan order. A `Record`
 * over the union rather than a list, so a reason added to the schema stops the build here.
 */
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

/**
 * What a file's recoverable parse errors amount to, for the one line the warning gives each file.
 *
 * The count and the first position, not every error: tree-sitter reports one ERROR node per
 * construct it could not place, so a single unterminated brace can produce dozens, and the first
 * is where the recovery began. The rest are on `ScanResult.parseErrors` for a caller that wants
 * them.
 *
 * The empty case is unreachable — the core records a file on `parseErrors` only when it has at
 * least one — but the list arrives as a plain array, so it is answered rather than asserted.
 */
function describeParseErrors(errors: readonly ParseError[]): string {
  const first = errors[0]
  if (first === undefined) return "parse errors reported without detail"
  const where = `${first.line}:${first.column} — ${first.message}`
  return errors.length === 1 ? where : `${errors.length} errors, first at ${where}`
}

/** A line that stands on its own: `⚠`, the scan's label when one was given, then the text. */
type SayIncident = (line: string) => void

/**
 * `cli-spec.md` stderr warnings — surface parse failures / soft timeouts / discovery-time skips
 * so a scan that ate 50 broken files still produces a visible signal. Each clause fires only on
 * a non-empty incident.
 *
 * `label` goes inside the line, after the glyph, so `⚠` starts every line that stands on its
 * own; only the indented per-file listings and their `…and N more` tails go without it.
 *
 * Exported, so a caller can assemble a `ScanReport` from something other than a scan — with
 * the contract that every `report.skipped[].reason` is a member of this package's
 * `SkippedFile["reason"]`, since the skip section looks each one up in a table total over it.
 */
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
  // The accounts that exist nowhere else come directly under the coverage line, ahead of
  // everything recoverable from the artifact: the sink's failure is swallowed further up, so
  // whatever is last is what a closed pipe loses.
  reportUnrepresentable(report.unrepresentableFiles, sayIncident, warn)
  reportTreeReleaseFailures(report.treeReleaseFailures, sayIncident, warn)
  reportParseErrors(report.parseErrorFiles, sayIncident, warn)
  reportConfigOutsideWorkspaceRoot(report, sayIncident)
  if (report.parseFailureCount > 0) {
    // Apart from the line above: those files are in the IR with warnings, these are not in it.
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

/**
 * What the typed tier actually bought. The request line cannot answer it: a hover that comes
 * back on time carrying nothing usable is a healthy row in every counter (lsp-enrichment.md).
 * Quiet only for a run that neither produced nor refused a hint. The rejection total
 * rather than the five buckets: `stats.lspEnrichment.hintsRejected` in the IR is where to look.
 */
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

/**
 * Files that parsed with errors the plugin called recoverable, and the first error each one
 * reported. Named rather than only counted, because a count says a number of files somewhere
 * in the workspace need looking at without saying which — `lang-plugin.md` leaves what counts
 * as recoverable to the plugin, so the reader cannot narrow it down from the count either.
 *
 * **Uncapped**, for the reason `reportUnrepresentable` is: for most of these files the line is
 * the run's only account of them (see `ScanReport.parseErrorFiles` for the two kinds that are
 * also in `stats.skippedFiles[]`), and a `…and N more` tail over the only account is the loss
 * rather than a summary of it.
 *
 * Gated on the list rather than on `parseErrorCount`, so an empty list cannot print a header
 * over nothing if the two ever come apart.
 */
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

/**
 * Parse trees a plugin was asked to free and did not, grouped by plugin because the plugin is
 * what the reader has to fix. The consequence is stated because nothing else about the run
 * says it: the exit code is unmoved, and the run that pays is the next, longer one.
 */
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

/**
 * The line that accounts for this run's exit code when coverage is what earned it. Above the
 * census that explains it, and below only the workspace's own manifests: a coverage number
 * over the wrong set of components is not something a reader can act on.
 */
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
  // Down for what was achieved and up for the floor, so the two never meet on one integer:
  // rounding both prints `899 of 1000 file(s) parsed (90%), below the floor of 90%`.
  const percent = Math.floor((fault.parsedFiles / fault.totalFiles) * 100)
  sayIncident(
    `${fault.parsedFiles} of ${fault.totalFiles} file(s) parsed (${percent}%), below the ` +
      `minParsedFileRatio floor of ${Math.ceil(fault.floor * 100)}%. ` +
      "Raise the coverage, or lower the floor if this is what the workspace looks like now.",
  )
}

/**
 * Config discovery is anchored to `cwd`, everything inside the config to the workspace root
 * (see `pinConfig`). When the two differ — a monorepo package with its own `aburi.json` —
 * neither is visible from the command line, so say it. A pinned config is exempt: `aburi
 * diff`'s base scan reads the head tree's config against a temporary worktree, so the two
 * never match and nobody ran anything from a package.
 */
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

/**
 * The census of what the scan gave up on, then each reason's files with the detail
 * `@aburi/core` wrote for them. For `over-size`, `unroutable`, and an `unreadable` raised at
 * discovery this is the only account there is; for the rest the core's per-file line goes to
 * a sink `ABURI_LOG_LEVEL=error` silences.
 *
 * Capped per reason rather than across the listing: one budget would be spent by whichever
 * reason lost the most files, pushing the one file withdrawn during extraction — the only
 * reason here that moves the exit code — inside `…and N more`.
 */
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

/**
 * Files the Document has no way to name: its own section rather than a seventh skip reason,
 * because there is no path a skip entry could take, and this paragraph is the whole record.
 *
 * **Uncapped**, unlike every other listing here: a truncated skip group is still recoverable
 * from `stats.skippedFiles[]`, this one from nothing. What keeps it short is grouping by the
 * *name* that has to change — one line per rename the reader has to perform.
 *
 * The `ignore` advice warns about the spelling because patterns reach picomatch, which spends
 * a lone backslash as an escape: `src/v\1/**` does not match `src/v\1/util.ts`.
 */
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
        // A third reason routed to neither section would print nothing while the gate still
        // reads `unrepresentableFiles.length` — exit 3 over an empty screen. The subject names
        // where the reason came from, because the fix is a section here rather than anything
        // in the workspace the reader is standing in.
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

/**
 * Two spellings of one name, which the Document has one path for and therefore no name for.
 * Every claimant is spelled out by codepoint: the names are different bytes and the same
 * glyphs, so a terminal would print the offending line twice identically.
 *
 * The `ignore` half is stated per outcome because the patterns do different things: the group
 * header excludes only the claimant spelled exactly that way (the rest stay scannable), a
 * wildcard over the group excludes them all, and neither is the fix, which is a rename.
 */
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

/**
 * Whether this scan read enough of the workspace for its answer to mean anything.
 *
 * `parsedFiles === 0` is unconditional; anything above zero is the workspace's own call via
 * `minParsedFileRatio`, since where the line sits depends on the repository. `keptSymbols` is
 * deliberately not consulted: a repository of configuration and tests is not a failed scan.
 */
function findCoverageFault(
  totalFiles: number,
  parsedFiles: number,
  skipped: readonly { reason: SkippedFile["reason"] }[],
  floor: number | undefined,
): CoverageFault | null {
  if (parsedFiles === 0) {
    // No dominant reason means nothing was skipped, which with nothing parsed means nothing
    // was found; `totalFiles === 0` is that same state and is not checked separately.
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
  // `<`, not `<=`: a floor is a statement about what is unacceptable, and exactly the floor is
  // not below it. The same reading `--fail-on`'s thresholds already use.
  if (parsedFiles / totalFiles < floor) {
    return { kind: "below-floor", parsedFiles, totalFiles, floor }
  }
  return null
}

/**
 * The reason that took the most files, so a run that lost everything says what to look at.
 * Ties go to the earlier reason in `REASON_REPORT`'s order, so the line is a function of the
 * losses rather than of scan order. `null` for an empty list.
 */
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

/**
 * `Stats.callResolution` is optional in the schema for older documents, but `scan()` always
 * fills it in. Substituting zeroes would print a clean bill of health for a run that measured
 * nothing, so a missing field is reported as the contract breach it would be.
 */
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

/**
 * Refuse to scan with no language plugin resolved. Nothing can be parsed in that state, and
 * the IR would fail its own schema (`workspace.languages` is `minItems: 1`, invariant #18);
 * catching it here is about the message, which says what to do rather than naming a symptom.
 */
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

/**
 * Check a config-supplied component root against the rule the IR holds every path to. The
 * config schema's `RelativePath` admits `"../shared"`; left to `assertIRIntegrity` at the end
 * of the scan it would be blamed on the Document and exit 1. Checked here it names the file
 * the user can edit, inside the wrapper that makes it exit 2.
 */
function assertWorkspaceRelative(root: string, componentId: string): string {
  const normalized = root.normalize("NFC")
  const violation = posixWorkspaceRelativeViolation(
    normalized,
    `components[id=${componentId}] root`,
  )
  if (violation !== null) throw new CoreError(violation.message, violation)
  return normalized
}

/**
 * The components the config declares, or undefined when it leaves them to detection. Read by
 * `resolveComponents` and by `fellBackToSingleComponent`, which must agree.
 */
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
      // Ids and language tokens arrive as plain strings and go through the constructors, so a
      // config loaded by some other path cannot smuggle in a shape the IR grammar refuses.
      return declared.map((entry) => {
        // `publicApi` / `frameworks` are Class B and `description` is Class A (`ir-schema.md`):
        // the empty arrays disappear, the scalar stays as `null`, matching what
        // `detectComponents` emits. `languages` is optional in the config but `minItems: 1`
        // in the IR, so it falls back to the same `["ts"]` detection uses.
        const languages = (entry.languages ?? []).map(makeLanguageId)
        const component: Component = {
          id: makeComponentId(entry.id),
          name: entry.name ?? entry.id,
          roots: entry.roots.map((root) => assertWorkspaceRelative(root, entry.id)),
          languages: languages.length > 0 ? languages : [makeLanguageId("ts")],
          description: entry.description ?? null,
        }
        if (entry.publicApi !== undefined && entry.publicApi.length > 0) {
          // NFC, as `collectPublicApi` does for the detected path (ir-schema.md): the
          // previous revision's array was read off disk and is therefore normalized.
          component.publicApi = entry.publicApi.map((pattern) => pattern.normalize("NFC"))
        }
        if (entry.frameworks !== undefined && entry.frameworks.length > 0) {
          component.frameworks = [...entry.frameworks]
        }
        return component
      })
    }
    // The same *drop* decision the scan is about to make, so an ignored file cannot put a
    // language on a component. Not the same *routing* decision: `Component.languages` answers
    // "what is this written in", not "what did this run parse" (component-detect.md).
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

/**
 * Which of the two exit codes a failed component resolution deserves (`cli-spec.md`).
 * Detection walks the workspace and opens every `.gitignore`, so an `EACCES` is possible here,
 * and reporting it as a config error would send the reader through `aburi.json` for a mistake
 * that is not there. A `CoreError` naming a config-shaped fault keeps exit 2; everything else
 * is the machine's.
 */
function componentResolutionFailure(error: unknown): CliError {
  const configFault = error instanceof CoreError && CONFIG_COMPONENT_ERROR_CODES.has(error.code)
  return new CliError(
    `Failed to resolve components: ${errorMessage(error)}`,
    configFault ? "config-error" : "runtime-error",
    { cause: error },
  )
}

/**
 * `CoreError` codes that mean the workspace or its config is wrong, rather than the machine.
 * Listed rather than inferred: a new code exits 1 until someone decides otherwise, which is the
 * safe direction.
 */
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
  const md = projectWorkspace(ir, {
    suppressTimestamp: options.suppressTimestamp ?? false,
  })
  await writeOutputFile({ command, artefact: "the workspace Markdown", path }, md)
  return path
}

async function maybeWriteComponentMd(
  command: OutputCommand,
  format: "json" | "md" | "both",
  outputDir: string,
  ir: IR,
): Promise<string[]> {
  if (format === "json") return []
  const paths: string[] = []
  for (const component of ir.components) {
    const symbolsInComponent = ir.symbols.filter((symbol) => symbol.component === component.id)
    const md = projectComponent({
      component,
      symbols: symbolsInComponent,
      dependencies: ir.dependencies,
    })
    const path = resolve(outputDir, COMPONENTS_DIRNAME, `${component.id}.md`)
    await writeOutputFile(
      { command, artefact: `the Markdown for component "${component.id}"`, path },
      md,
    )
    paths.push(path)
  }
  return paths
}
