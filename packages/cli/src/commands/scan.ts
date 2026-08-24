import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  type CollidingFile,
  CoreError,
  describeCodePoints,
  detectComponents,
  detectManagers,
  languageFileDropPatterns,
  makeComponentId,
  makeLanguageId,
  posixWorkspaceRelativeViolation,
  type SkippedFile,
  scan,
  type UnnameableFile,
  type UnrepresentableFile,
  writeCanonicalIR,
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
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import {
  COMPONENTS_DIRNAME,
  IR_JSON_FILENAME,
  resolveOutputDir,
  WORKSPACE_MD_FILENAME,
} from "../artifact-paths"
import { resolveConfig } from "../config-load"
import type { LogLevel } from "../env"
import { CliError, errorMessage } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { readGeneratorInfo } from "../generator-info"
import { createLogger } from "../logger"
import { loadPlugins } from "../plugin-loader"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"

export interface ScanOptions {
  cwd?: string
  configPath?: string
  outputDir?: string
  format?: "json" | "md" | "both"
  ignore?: readonly string[]
  /**
   * Override for `Config.respectGitignore`. `true` from `--respect-gitignore`, `false` from
   * `--no-respect-gitignore`, absent when neither was typed — which is the only value that
   * leaves the config's own answer standing, and so the only correct one for a caller that
   * has nothing to say about it. A caller passing the flag's default rather than omitting the
   * field asks for that default, and gets it.
   */
  respectGitignore?: boolean
  compact?: boolean
  suppressTimestamp?: boolean
  strict?: boolean
  /**
   * Override for `Config.lsp.enabled`. `true` from `--lsp`, `false` from
   * `--no-lsp`, `undefined` when neither flag was passed (falls through to the
   * on-disk config value). Follows the CLI override precedence rule in
   * `docs/design/config.md` §11.
   */
  lsp?: boolean
  /**
   * Lowest level the run's `Logger` emits, from `ABURI_LOG_LEVEL` (§11).
   * Defaults to `"warn"`, which is what the CLI has always printed.
   */
  logLevel?: LogLevel
  /**
   * Where this scan's incident report goes (§5.6), and what to call this scan in it. Omit it
   * and the report goes nowhere.
   *
   * It is one option rather than two because the label means nothing without the sink;
   * separate optionals would let a caller pass a label and get silence.
   *
   * Not the same as silence. The run's `Logger` is a separate channel — per file rather than
   * per run, governed by `ABURI_LOG_LEVEL`, and still defaulting to `process.stderr` — so a
   * scan with no sink here is quiet, not mute. Routing that channel to a caller-injected
   * stream is a known gap and is not this option.
   *
   * The reporting lives here rather than in the command wrapper because three commands scan
   * and only one of them was doing it. A caller that forgets the sink now loses the report for
   * its own scan; a caller that forgot to call a separate reporter used to lose it while the
   * scan looked handled.
   */
  incidents?: {
    warn: WarnFn
    /**
     * Names this scan in its own lines — `base ref "main"`, `head (working tree)`.
     *
     * `aburi diff` runs two scans and the same incident means different things at each: a file
     * withdrawn at base makes phantom `added` entries, the same file withdrawn at head makes
     * phantom `removed` ones. Omitted when only one scan ran, where a label would be noise.
     */
    label?: string
  }
}

/**
 * A scan that read too little of the workspace to be worth believing.
 *
 * The shape it produces is the dangerous one because it is a *success*: an IR with no Symbols
 * diffs against another one as `+0 -0 ~0`, so every `--fail-on` gate downstream passes and the
 * run that lost the workspace is the one that looks healthiest.
 *
 * Three kinds because the first move differs. Nothing discovered points at `ignore`, at
 * `components[].roots`, and at whether a loaded plugin claims anything in this repository —
 * questions about the config. Nothing parsed points at whatever withdrew the files, which is
 * why it carries the reason that took the most of them. Below the floor is a policy the
 * workspace opted into, so it says what it measured and what it was held to.
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
  /**
   * Files that reached the IR — `totalFiles` less everything on `skipped`.
   *
   * Read rather than derived, because it is the counter the Document itself publishes and the
   * one integrity invariant #21 holds the skip list against. A CLI that recomputed it would be
   * free to disagree with the artifact it just wrote.
   */
  parsedFiles: number
  keptSymbols: number
  droppedSymbols: number
  /**
   * Files carrying parse errors the plugin called recoverable — every file on
   * `ScanResult.parseErrors` except the ones withdrawn *for* a parse error, which
   * `parseFailureCount` counts instead. The stderr line built from this number says
   * "recoverable", and a withdrawn file's error said the opposite.
   *
   * Not the same as "still reached the IR". A file abandoned on its `parseTimeoutMs` budget
   * is counted here and is not in the IR — deliberately, because its errors really are all
   * recoverable (the withdrawal check runs before the first deadline reading) and they are
   * the reason `lang-plugin.md` §7.1.2 keeps them: a slow parse is often a slow parse of
   * broken input, and a reader told only about the budget would go and raise it.
   */
  parseErrorCount: number
  /**
   * Files withdrawn because the parse produced nothing usable — a null tree, or a
   * `ParseError` the language plugin marked `recoverable: false`. The same files appear in
   * `skipped` under `reason: "parse-failed"`.
   *
   * This does not move the exit code. Unlike `extractionFailures`, it describes the source
   * rather than the plugin set: an unparseable file is a fact about the workspace, the way
   * an over-size or timed-out one is.
   */
  parseFailureCount: number
  timeoutCount: number
  /**
   * Files that never made it into the IR. `over-size` and `unroutable` are decided before
   * anything is read; `unreadable` can come from either side; `parse-failed`,
   * `parse-timeout` and `extraction-failed` are decided during extraction. Surfaced
   * separately from `parseErrorCount` because `@aburi/core` returns these rather than
   * printing them, and a discovery-time drop is not logged at all. Warning on stderr is the
   * CLI's job either way.
   */
  skipped: readonly { path: string; reason: SkippedFile["reason"]; detail?: string }[]
  /**
   * Files a plugin threw on, with what it said and the error's own code where it had one.
   *
   * The same files are in `skipped` under `reason: "extraction-failed"`, carrying the same
   * message — the scan writes it to both at one site — so this is not where the message
   * lives, and the incident report reads it from `skipped` with every other reason's. What
   * is only here is the `code`, and the standing that goes with it: this is the one reason
   * that means something in the run is *broken* rather than merely large, slow, or in a
   * language no plugin claims, so it is what moves the exit code and what the `diff` fault
   * clause counts.
   */
  extractionFailures: readonly { file: string; message: string; code?: string }[]
  /**
   * Present when the LSP enrichment pass ran (config.lsp.enabled = true and at
   * least one server was configured). Absent when LSP was skipped entirely.
   */
  lspEnrichment: LspEnrichmentStats | undefined
  /**
   * Head-side call-resolution census rendered for stdout (call-resolution.md
   * §8.1). Always present — `scan` emits the counters unconditionally.
   */
  callResolutionLine: string
  /**
   * Per-call diagnostics behind that census. Kept out of the IR by design
   * (§8.1) and consumed by `aburi explain --debug-resolution`.
   */
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  /**
   * Absolute path of the config that was read, or `null` when discovery found none and the
   * run fell through to autodetect. Discovery starts at `cwd` while everything inside the
   * config resolves against `workspaceRoot`, so which file won is not deducible from the
   * arguments and belongs on the report.
   */
  configSource: string | null
  /** Marker-detected root; the base for Symbol id paths and the config's relative globs. */
  workspaceRoot: string
  /**
   * Why this scan's coverage is not worth believing, or `null`.
   *
   * Computed once and carried, rather than left for each caller to decide from the counters:
   * `exitCode` below is derived from this field, `reportScanIncidents` renders it, and
   * `aburi diff` names it as the cause of its own exit. Three readings of one condition would
   * be three chances to disagree about whether the run was green.
   */
  coverageFault: CoverageFault | null
  /**
   * Candidate files the Document has no way to name, in path order.
   *
   * Nothing else on this report mentions them, and nothing in the artifact does either: the
   * path a skip entry would need is one the shared path rule refuses, and a file counted in
   * `totalFiles` while absent from `stats.skippedFiles` breaks integrity #21. So the run's only
   * account of them is this list, which is why it moves the exit code — a scan that dropped
   * source and said nothing would be a clean run over a workspace it did not describe.
   */
  unrepresentableFiles: readonly UnrepresentableFile[]
  exitCode: ExitCode
}

/**
 * §5 — `aburi scan`. Resolves config, loads plugins, runs `@aburi/core` `scan`, then
 * writes IR JSON and per-Component Markdown into `--output-dir` (default `out/`).
 *
 * The function writes nothing to the process streams of its own accord: summaries are the CLI
 * wrapper's to print, and the incident report goes to `options.incidents.warn` if a caller
 * supplied one. The run's `Logger` is not covered by that — it still defaults to
 * `process.stderr`, so a caller that injects streams hears the per-run report on its own sink
 * and the per-file log lines on the real one. Integration tests can therefore assert on the
 * report and on the exact incident lines, but a captured stream is not the whole of stderr.
 */
export async function runScan(options: ScanOptions = {}): Promise<ScanReport> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)

  const loaded = await resolveConfig(cwd, options.configPath)
  const config = mergeCliOverrides(loaded.config, options)

  const plugins = await loadPlugins({
    config,
    workspaceRoot,
    syntheticPlugins: loaded.syntheticPlugins,
  })
  requireLanguagePlugin(plugins.languages.length, loaded.source)

  const managers = await detectManagers(workspaceRoot)
  const components = await resolveComponents(config, workspaceRoot, plugins.languages)

  const scanInput: Parameters<typeof scan>[0] = {
    workspaceRoot,
    config,
    languages: plugins.languages,
    frameworks: plugins.frameworks,
    effects: plugins.effects,
    registry: plugins.registry,
    workspaceManagers: managers.managers.map((m) => ({
      tool: m.tool,
      roots: [...m.roots],
    })),
    components,
    generator: await readGeneratorInfo(),
    logger: createLogger(options.logLevel === undefined ? {} : { minimum: options.logLevel }),
  }
  const scanResult = await scan(scanInput)

  const format = options.format ?? "both"
  const outputDir = resolveOutputDir(cwd, options.outputDir, config.output?.dir)
  await mkdir(outputDir, { recursive: true })

  let irPath: string | null = null
  const workspaceMdPath = await maybeWriteWorkspaceMd(format, outputDir, scanResult.ir, options)
  const componentMdPaths = await maybeWriteComponentMd(format, outputDir, scanResult.ir)
  if (format !== "md") {
    irPath = resolve(outputDir, IR_JSON_FILENAME)
    // Serialization can refuse the document — two object keys that differ only in Unicode
    // composition cannot both be written without one being lost on read-back. That is a
    // property of the scanned project, so it belongs on the input-error exit code with the
    // target path attached, not on the generic handler as a bare runtime failure.
    try {
      await writeCanonicalIR(scanResult.ir, irPath, {
        format: options.compact ? "compact" : "pretty",
      })
    } catch (error) {
      throw new CliError(
        `Failed to write IR to ${irPath}: ${errorMessage(error)}`,
        "config-error",
        {
          cause: error,
        },
      )
    }
  }

  // A withdrawn file's parse errors are still reported — they are the account of why it was
  // withdrawn — so the two counts below would otherwise both include it, and one of them
  // would call its errors recoverable.
  const withdrawnByParse = new Set(
    scanResult.skipped.filter((s) => s.reason === "parse-failed").map((s) => s.path),
  )

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
    parseErrorCount: scanResult.parseErrors.filter((p) => !withdrawnByParse.has(p.file)).length,
    parseFailureCount: withdrawnByParse.size,
    timeoutCount: scanResult.timeoutEvents.length,
    skipped: scanResult.skipped.map((s) => {
      const entry: { path: string; reason: SkippedFile["reason"]; detail?: string } = {
        path: s.path,
        reason: s.reason,
      }
      if (s.detail !== undefined) entry.detail = s.detail
      return entry
    }),
    extractionFailures: scanResult.extractionFailures.map((f) => ({ ...f })),
    lspEnrichment: scanResult.ir.stats.lspEnrichment,
    callResolutionLine: formatCallResolutionLine(requireCallResolution(scanResult.ir)),
    unresolvedCalls: scanResult.unresolvedCalls,
    configSource: loaded.source,
    workspaceRoot,
    coverageFault,
    unrepresentableFiles: scanResult.unrepresentableFiles.map((f) => ({ ...f })),
    // Three gates (`cli-spec.md` §5.4, §5.7, §5.8), and none withholds anything the run would
    // otherwise have written — a reviewer gets whatever `--format` asked for and a non-zero
    // code, where before either guard existed they got the artifact and a green light.
    //
    // A file lost to a plugin exception says the run is broken rather than merely partial.
    // A scan that parsed nothing says the run described nothing, which is worse in the one
    // way that matters downstream: it is a *success* today, and an IR with no Symbols passes
    // every `--fail-on` gate it is later compared through.
    //
    // Losing files while still parsing some keeps exiting 0 unless the workspace set
    // `minParsedFileRatio`, which reaches this line as a `coverageFault` like the other two
    // rather than as a condition of its own.
    //
    // A file the Document cannot name is the third: it is source the workspace holds and the
    // artifact does not describe, and unlike every other loss there is no entry in the
    // artifact to find it by afterwards. Nothing but this exit code and the line above it
    // says the workspace was read incompletely.
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
      // The report is complete and the IR is on disk by now, so the exit code must not depend
      // on whether the channel that describes them survived. A sink writing to a closed pipe
      // — `aburi scan 2>&1 | head -1` — would otherwise turn a gate into a runtime error and
      // send a reader looking for a fault that is not there. There is nowhere to report the
      // failure of the reporting channel, which is why this is the one swallow in the file.
      //
      // It absorbs more than the sink. Whatever line the report was on when it threw, the
      // rest of the report goes with it — the skip section and every LSP warning after it —
      // leaving the lines already written on screen and, for a faulted scan, a non-zero
      // status with nothing accounting for it. The only throw not from the sink that
      // `reportScanIncidents` can raise is a `skipped[].reason` outside this package's union,
      // which nothing in-tree can produce; see the contract on that function.
    }
  }
  return report
}

/**
 * How many withdrawn files a reason names individually before the rest are counted.
 *
 * A fault broken enough to lose one file usually loses them all, so the untruncated list is
 * the whole workspace — which on CI scrolls every other warning out of the log it was meant
 * to appear in. Ten is enough to see the shape (one path, or many) and read the detail,
 * which is identical across them when the cause is a plugin rather than the files.
 *
 * Per reason rather than across the listing. One budget shared by all six would be spent by
 * whichever reason lost the most files, and the reason that lost the most is not the reason
 * a reader most needs named: a hundred over-size files would push the one file a plugin
 * threw on — the only reason *in this listing* that moves the exit code — inside `…and N more`,
 * leaving a non-zero status with nothing on screen to account for it.
 *
 * The two gate reasons that are not skip reasons print their own sections, and one of those is
 * uncapped: where the artifact holds no copy of the list, a tail is the tool declining to say
 * what it alone knows. Here it is a pointer into `stats.skippedFiles[]`, which holds every one.
 */
const MAX_LISTED_PER_REASON = 10

/**
 * Where each reason sits in the report, and what to do about it.
 *
 * `advice` is the whole difference between them, and the one line they used to share said
 * none of it: `over-size` points at a budget, `parse-timeout` at a different budget and a
 * re-run, `unreadable` at a re-run alone — a tree that changed under the scan is the only
 * thing that produces it — `unroutable` at a bug report or at a rename, and the two
 * extraction reasons at the source and at the plugin respectively. The re-run /
 * fix-something split is the one the reason's own schema docstring draws: `parse-timeout`
 * depends on how loaded the machine was, everything else describes the file and clears only
 * when something changes.
 *
 * `rank` fixes the order the census and the groups under it come out in, which would
 * otherwise be the order the files arrived in — scan order, and so a function of where in
 * the workspace the losses happened to sit. It follows the order the schema's `reason` enum
 * declares, which is also the order the generated union lists. Not the order the schema's
 * prose beside that enum groups them in: that prose puts `over-size` and `unroutable`
 * together as decided before the file was read, and no single sequence is both.
 *
 * The ranks must stay distinct. `Array.prototype.sort` is stable and the map they order was
 * filled in scan order, so two reasons sharing a rank would tie and fall back to exactly the
 * dependency on workspace layout this exists to remove — a `number` does not say so and no
 * test would catch it.
 *
 * A `Record` over the union rather than a list, so a reason added to the schema stops the
 * build here. A list would have compiled, and quietly left the new reason's files out of the
 * report while the census above still counted them.
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
    advice: "a plugin threw while extracting. This is the reason the run does not exit clean.",
  },
}

/**
 * §5.6 — surface parse failures / soft timeouts / discovery-time skips so a scan that ate 50
 * broken files still produces a visible signal. The main summary line on stdout stays clean;
 * each clause below fires only on a non-empty incident.
 *
 * `label` names the scan when more than one ran in the same command. It goes inside the
 * line, after the glyph, so `⚠` starts every line that stands on its own. The only lines
 * without it are the indented per-file listing and its `…and N more` tail, which belong to
 * the line above them and are attributed by it.
 *
 * Exported, so a caller can assemble a `ScanReport` from something other than a scan. One
 * contract comes with that: every `report.skipped[].reason` must be a member of this
 * package's `SkippedFile["reason"]`, because the skip section looks each one up in a table
 * that is total over it and has nowhere to put a seventh. A document written by a newer
 * Aburi is the way that could happen; `workspace:*` pins the two together in-tree.
 */
export function reportScanIncidents(report: ScanReport, warn: WarnFn, label: string | null): void {
  const say = (line: string): void => {
    warn(label === null ? `⚠ ${line}` : `⚠ ${label}: ${line}`)
  }
  reportCoverageFault(report.coverageFault, say)
  // Directly under the coverage line, ahead of everything recoverable from the artifact. The
  // skip census below can run to six reasons of eleven lines each, and the sink this all goes
  // through is one whose failure is deliberately swallowed further up — so the account that
  // exists nowhere else is the one that must not be last.
  reportUnrepresentable(report.unrepresentableFiles, say, warn)
  reportConfigOutsideWorkspaceRoot(report, say)
  if (report.parseErrorCount > 0) {
    say(`${report.parseErrorCount} file(s) had recoverable parse errors.`)
  }
  if (report.parseFailureCount > 0) {
    // Apart from the line above rather than folded into it: those files are in the IR with
    // warnings against them, these are not in it at all, and the difference is the whole
    // reason a reader is reading the count. The skip summary below names them too, among
    // every other reason a file went missing; this says which of them are unparseable.
    say(`${report.parseFailureCount} file(s) could not be parsed and were left out of the IR.`)
  }
  if (report.timeoutCount > 0) {
    say(`${report.timeoutCount} effect classification(s) hit the per-call timeout budget.`)
  }
  reportSkipped(report.skipped, say, warn)
  const lsp = report.lspEnrichment
  if (lsp !== undefined) {
    if (lsp.filesFellBack > 0) {
      say(
        `LSP enrichment fell back for ${lsp.filesFellBack} file(s); IR field values in those files remain at the untyped tier.`,
      )
    }
    if (lsp.languagesDisabled.length > 0) {
      say(`LSP disabled mid-run for language(s): ${lsp.languagesDisabled.join(", ")}.`)
    }
    if (lsp.requestsTimedOut > 0 || lsp.requestsFailed > 0) {
      // Its own line, not a detail of the two above: it has its own condition and fires when
      // neither of them did. Left indented and glyphless it was the one warning `⚠` did not
      // start, and in a two-scan `diff` it was the one nothing could attribute to a side.
      say(
        `LSP requests: ${lsp.requestsIssued} issued · ${lsp.requestsTimedOut} timed out · ${lsp.requestsFailed} failed.`,
      )
    }
  }
}

/**
 * The line that accounts for this run's exit code when coverage is what earned it.
 *
 * First, above the census that explains it: it is the finding, and the counts below it are the
 * evidence. A reader who stops after one line has the one that changes what they do.
 *
 * Each kind says where to look. Discovery found nothing → the config decided that, and the
 * three things in it that can. Nothing parsed → whatever withdrew the files, named. Below the
 * floor → what was measured against what the workspace asked for.
 */
function reportCoverageFault(fault: CoverageFault | null, say: (line: string) => void): void {
  if (fault === null) return
  const consequence = "The IR is empty and will diff clean against any other empty IR."
  if (fault.kind === "nothing-discovered") {
    say(
      `No file was discovered to scan. ${consequence} Check ignore and .gitignore, ` +
        "components[].roots, and whether a loaded language plugin claims any extension in this workspace.",
    )
    return
  }
  if (fault.kind === "nothing-parsed") {
    say(
      `${fault.totalFiles} file(s) discovered, 0 parsed — ${fault.dominantCount} as ` +
        `${fault.dominant}. ${consequence}`,
    )
    return
  }
  // Down for what was achieved and up for the floor, so the two never meet on one integer.
  // Rounding both to nearest prints `899 of 1000 file(s) parsed (90%), below the floor of 90%`,
  // which reads as a bug in the tool. Away from each other the sentence is true for every pair
  // that reaches this line: the reading is strictly below the floor, so its floored percentage
  // is strictly below the floor's ceilinged one. The cost is a digit of precision, on a line
  // that already carries both exact counts.
  const percent = Math.floor((fault.parsedFiles / fault.totalFiles) * 100)
  say(
    `${fault.parsedFiles} of ${fault.totalFiles} file(s) parsed (${percent}%), below the ` +
      `minParsedFileRatio floor of ${Math.ceil(fault.floor * 100)}%. ` +
      "Raise the coverage, or lower the floor if this is what the workspace looks like now.",
  )
}

/**
 * Config discovery is anchored to `cwd`, everything inside the config to the workspace
 * root. When the two directories differ — running inside a monorepo package that has its
 * own `aburi.json` — a relative path in that file points somewhere other than where its
 * author was looking, and the scan still covers the whole workspace. Both are deliberate
 * (see `resolveConfig`), and neither is visible from the command line, so say it.
 */
function reportConfigOutsideWorkspaceRoot(report: ScanReport, say: (line: string) => void): void {
  if (report.configSource === null) return
  if (dirname(report.configSource) === report.workspaceRoot) return
  say(
    `Config ${report.configSource} sits below the workspace root ${report.workspaceRoot}. ` +
      `Paths inside it (ignore, components[].roots, relative plugin refs) resolve against the root, ` +
      `and the scan covers the whole workspace.`,
  )
}

/**
 * The census of what the scan gave up on, then each reason's files with the detail
 * `@aburi/core` wrote for them.
 *
 * The details are the point. For `over-size`, `unroutable`, and an `unreadable` raised at
 * discovery this is the only account there is — those three are not logged at all — and for
 * the other three the core's per-file line goes to a sink `ABURI_LOG_LEVEL=error` silences
 * and that never reaches a caller who injected its own streams. `ScanReport.skipped` has
 * always carried the path and the detail; what dropped them was the line, whose input type
 * was `readonly { reason: string }[]`, so five of the six reasons reached the reader as a
 * bare count. (`extraction-failed` was listed, from a second field holding the same string.)
 *
 * It is a detail per file rather than per reason because a reason's files rarely share one:
 * a size and a budget, an errno, a parse position. The rule is that a detail the core
 * bothered to write is a detail this prints, so a reason added later is listed by the same
 * code that lists the six here.
 */
function reportSkipped(
  skipped: ScanReport["skipped"],
  say: (line: string) => void,
  warn: WarnFn,
): void {
  if (skipped.length === 0) return
  // Grouped from the files and then ordered, rather than walked reason by reason: every file
  // handed over is in a group by construction, so the census below cannot come to more than
  // the groups under it account for.
  const byReason = new Map<SkippedFile["reason"], ScanReport["skipped"][number][]>()
  for (const file of skipped) {
    const group = byReason.get(file.reason)
    if (group === undefined) byReason.set(file.reason, [file])
    else group.push(file)
  }
  const groups = [...byReason].sort(([a], [b]) => REASON_REPORT[a].rank - REASON_REPORT[b].rank)
  const census = groups.map(([reason, files]) => `${reason}=${files.length}`).join(", ")
  say(`${skipped.length} file(s) contributed no Symbols: ${census}`)
  for (const [reason, files] of groups) {
    say(`${reason} (${files.length}) — ${REASON_REPORT[reason].advice}`)
    for (const file of files.slice(0, MAX_LISTED_PER_REASON)) {
      // Empty as well as absent. Nothing in a scan produces either any more: every detail
      // derived from a thrown value goes through `describeThrown`, which is total on
      // non-emptiness, and the rest are built at their site from non-empty literals. But this
      // function is exported for a report a caller assembled, where the field is optional and
      // one that says nothing renders as `    src/x.ts: ` — a path, a colon, and silence.
      const detail = file.detail ?? ""
      warn(detail.length === 0 ? `    ${file.path}` : `    ${file.path}: ${detail}`)
    }
    const hidden = files.length - MAX_LISTED_PER_REASON
    if (hidden > 0) warn(`    …and ${hidden} more`)
  }
}

/**
 * Files the Document has no way to name.
 *
 * Its own section rather than a seventh skip reason. A skip entry is a path plus a reason, and
 * the path it would take is one the shared rule refuses — so there is no entry to group, no
 * count in `totalFiles` to reconcile it against, and nothing in the artifact a reader could
 * find the file by later. This paragraph is the whole record.
 *
 * **Uncapped**, which every other listing here is not. A truncated skip group is still
 * recoverable from `stats.skippedFiles[]`; this one is recoverable from nothing, so a
 * `…and N more` would be the tool declining to say what it alone knows. What keeps it short
 * is grouping instead: one line per *name* that has to change rather than one per file, which
 * for the usual shape — a directory whose name holds the character — is a single line however many
 * files sit under it. That count is also the number of renames the reader has to perform, so
 * the listing is the length of the work rather than the length of the damage.
 *
 * The `ignore` half of the advice carries its own warning because the obvious spelling is
 * wrong. Patterns reach picomatch, which spends a lone backslash as an escape, so
 * `src/v\1/**` does not match `src/v\1/util.ts` while `src/v\\1/**` does. Printing the name
 * and then advising a pattern the name does not satisfy would send a reader round the loop
 * with an identical exit 3 and nothing on screen to say why.
 */
function reportUnrepresentable(
  files: ScanReport["unrepresentableFiles"],
  say: (line: string) => void,
  warn: WarnFn,
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
        // A third reason routed to neither section prints nothing while the gate still reads
        // `unrepresentableFiles.length` — exit 3 over an empty screen, about the one list the
        // artifact holds no copy of. Two `filter` calls compiled happily in that state; this
        // does not. `reportSkipped` keeps the same property by looking its reason up in a
        // table that is total over the union.
        assertNeverUnrepresentable(file)
    }
  }
  reportUnspellable(unspellable, say, warn)
  reportColliding(colliding, say, warn)
}

/** Compile-time guard: a new `UnrepresentableFile` member is a type error rather than silence. */
function assertNeverUnrepresentable(file: never): never {
  throw new CliError(
    `@aburi/core reported a file the Document cannot name for a reason this CLI has no section for: ${JSON.stringify(file)}`,
    "runtime-error",
  )
}

/** One section per cause, because the fix differs and the two are told apart by nothing else. */
function reportUnspellable(
  files: readonly UnnameableFile[],
  say: (line: string) => void,
  warn: WarnFn,
): void {
  if (files.length === 0) return
  const byPrefix = groupBy(files, (file) => file.unnameablePrefix)
  say(
    `${files.length} file(s) were left out of the IR and out of its counts, under ${byPrefix.size} name(s) with no spelling here: "/" is the only separator a Document path has, so a name holding a backslash cannot be written down at all. Rename each one below. To leave one out with ignore instead, write its backslash twice — a glob pattern spends a single one as an escape, so the name as printed does not match itself.`,
  )
  for (const [prefix, group] of byPrefix) {
    warn(
      group[0]?.fsPath === prefix
        ? `    ${prefix}`
        : `    ${prefix} — a directory, and the ${group.length} file(s) under it`,
    )
  }
}

/**
 * Two spellings of one name, which the Document has one path for and therefore no name for.
 *
 * Every claimant is spelled out by codepoint, and there is no way around that: the whole point
 * of the pair is that the two names are different bytes and the same glyphs, so a terminal
 * prints the offending line twice identically. This is the section a reader cannot act on
 * without being told which character differs.
 *
 * The `ignore` half is stated per outcome, because the patterns do different things and the
 * obvious summary of them is false. Measured against discovery's own options:
 *
 * - the group header excludes the claimant spelled exactly that way, if one is. The group drops
 *   to a single claimant, the collision is over, and the remaining file is scanned normally.
 * - a wildcard over the group excludes all of them, and the IR describes none.
 * - where no claimant is spelled as the header — two decomposed spellings of one composed path —
 *   the header matches nothing and the group is untouched.
 *
 * So the header is not a pattern that cannot work; it is the one that keeps a file. Which of
 * the two a reader wants is theirs to decide, and neither is the fix, which is a rename.
 */
function reportColliding(
  files: readonly CollidingFile[],
  say: (line: string) => void,
  warn: WarnFn,
): void {
  if (files.length === 0) return
  const byPath = groupBy(files, (file) => file.documentPath)
  say(
    `${files.length} file(s) were left out of the IR and out of its counts, on ${byPath.size} path(s) more than one name claims: the Document holds every string in Unicode NFC, and these names differ only in how they are composed, so normalizing them gives one path for several files. Rename all but one of each group. ignore matches the spelling on disk, so the path below excludes whichever claimant is spelled that way and leaves the rest of the group scannable, while a wildcard over it excludes them all.`,
  )
  for (const [documentPath, group] of byPath) {
    warn(`    ${documentPath} — claimed by ${group.length} file(s) on disk:`)
    for (const file of group) warn(`        ${describeCodePoints(file.fsPath)}`)
  }
}

/** Grouped and ordered by key, so the paragraph is the same paragraph on every run. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(key(item))
    if (group === undefined) groups.set(key(item), [item])
    else group.push(item)
  }
  return new Map([...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Whether this scan read enough of the workspace for its answer to mean anything.
 *
 * Two gates. `parsedFiles === 0` is unconditional: a Document with no Symbols is not a
 * description of a codebase, and the failure it produces downstream is silent — two of them
 * diff as `+0 -0 ~0`. Anything above zero is the workspace's own call, because where the line
 * sits between "lost some files" and "lost the workspace" depends on the repository, and a
 * default guess would red a build for a judgement nobody made.
 *
 * `keptSymbols` is deliberately not consulted. A file that parses cleanly and declares nothing
 * is counted as parsed, which is correct — a repository of configuration and tests is not a
 * failed scan — so a Symbol count says something about the code, and `parsedFiles` says what
 * this function is asked about.
 */
function findCoverageFault(
  totalFiles: number,
  parsedFiles: number,
  skipped: readonly { reason: SkippedFile["reason"] }[],
  floor: number | undefined,
): CoverageFault | null {
  if (parsedFiles === 0) {
    // No dominant reason means nothing was skipped, which together with nothing parsed means
    // nothing was found. `totalFiles === 0` is that same state said a third way, so it is not
    // checked separately — a second branch for it would be unreachable through one of them.
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
 *
 * Ties go to the earlier reason in `REASON_REPORT`'s order, which makes the line a function of
 * the losses rather than of the order the walk happened to reach them in — the same reason
 * `reportSkipped` orders its groups at all.
 *
 * Returns `null` for an empty list, which under `parsedFiles === 0` means nothing was found —
 * every file found and not parsed is on this list, so an empty one and a zero parse count
 * cannot both hold while anything was discovered.
 */
function dominantReason(
  skipped: readonly { reason: SkippedFile["reason"] }[],
): { reason: SkippedFile["reason"]; count: number } | null {
  const counts = new Map<SkippedFile["reason"], number>()
  for (const file of skipped) counts.set(file.reason, (counts.get(file.reason) ?? 0) + 1)
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
 * `Stats.callResolution` is optional in the schema so v1 documents written
 * before the field existed stay valid, but the IR we just produced came out of
 * `scan()`, which always fills it in. Substituting zeroes here would print
 * `calls 0 · resolved 0 · unresolved 0` — a clean bill of health for a run that
 * measured nothing — so a missing field is reported as the contract breach it
 * would be.
 */
function requireCallResolution(ir: IR): CallResolutionStats {
  const stats = ir.stats.callResolution
  if (stats === undefined) {
    throw new CliError(
      "scan() returned an IR without stats.callResolution; @aburi/core stopped emitting the call-resolution census (call-resolution.md §8.1).",
      "runtime-error",
    )
  }
  return stats
}

/**
 * Refuse to scan with no language plugin resolved.
 *
 * Nothing can be parsed in that state, so the run would write an IR with zero Symbols and
 * an empty `workspace.languages` — which the IR schema rejects (`minItems: 1`) and which
 * integrity invariant #18 rejects. Catching it here instead of letting the invariant fire
 * is about the message: "no language plugin is configured, add one" says what to do, where
 * "workspace.languages is empty" describes a symptom of it.
 *
 * The shape this replaces was the dangerous one, because it was a success: an empty IR
 * diffs against another empty IR as `+0 -0 ~0`, so every `--fail-on` gate downstream passed.
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
 * Both branches can fail on a Component id the schema cannot hold: the config branch if a
 * config reached us without ajv validation, the detection branch if a package or directory
 * name kebab-cases to nothing. Either way it is a problem with the project being scanned,
 * not a bug in Aburi, so it is wrapped as `config-error` — the exit-code table in
 * `../exit-codes` maps that to 2, and an unwrapped `CoreError` would fall through to the
 * generic handler and report 1 with no command context.
 */
/**
 * Check a config-supplied component root against the rule the IR holds every path to.
 *
 * The config schema's `RelativePath` constrains only `minLength: 1` and "no backslash", so
 * `"../shared"` is schema-valid and used to reach the IR untouched. It would now be caught
 * by `assertIRIntegrity` at the very end of the scan — reported as an integrity violation
 * against `components[id=…].roots`, blaming the Document for what the config said, and
 * exiting 1 through the generic handler. Checking it here instead keeps the report pointed
 * at the file the user can edit, and inside the wrapper that makes it exit 2.
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

async function resolveComponents(
  config: Partial<Config>,
  workspaceRoot: string,
  languages: readonly LanguagePlugin[],
): Promise<Component[]> {
  try {
    if (config.components !== undefined && config.components.length > 0) {
      // The config schema already constrains `id` to the kebab shape, but the value arrives
      // here as a plain string. Re-asserting it through the constructor is what turns it into
      // a Component id, and keeps a config loaded by some other path from smuggling in a
      // shape `components[].id` cannot hold.
      return config.components.map((entry) => {
        // `publicApi` / `frameworks` are Class B and `description` is Class A
        // (`ir-schema.md` §1.1), so the empty cases are spelled differently on purpose:
        // the two array keys disappear, the scalar stays as an explicit `null`. Emitting
        // `[]` here would contradict `detectComponents`, which omits them — the same
        // Component would then have two shapes depending on whether it was configured or
        // detected.
        // `languages` is optional in the config schema but `minItems: 1` in the IR schema,
        // so an entry that omits it would otherwise produce a document that fails its own
        // schema. Fall back to the same `["ts"]` that `detectComponents` uses when frequency
        // counting finds nothing, rather than inventing a second answer to the same question.
        // Each entry goes through `makeLanguageId`: `ComponentOverride.languages` is a
        // hand-written field with only `type: "string"` behind it in the config schema, so
        // this is where a config-supplied token is checked against the IR's grammar rather
        // than at the point it would surface as an unexplained schema failure.
        const languages = (entry.languages ?? []).map(makeLanguageId)
        const component: Component = {
          id: makeComponentId(entry.id),
          name: entry.name ?? entry.id,
          roots: entry.roots.map((root) => assertWorkspaceRelative(root, entry.id)),
          languages: languages.length > 0 ? languages : [makeLanguageId("ts")],
          description: entry.description ?? null,
        }
        if (entry.publicApi !== undefined && entry.publicApi.length > 0) {
          // NFC, as `collectPublicApi` does for the detected path (ir-schema.md §1.2). The
          // array decides an identity: `@aburi/diff` compares it against the previous
          // revision's, which was read off disk and is therefore normalized.
          component.publicApi = entry.publicApi.map((pattern) => pattern.normalize("NFC"))
        }
        if (entry.frameworks !== undefined && entry.frameworks.length > 0) {
          component.frameworks = [...entry.frameworks]
        }
        return component
      })
    }
    // The same drop decision the scan is about to make. Detection counts file extensions to
    // decide `Component.languages`, so a file this run refuses to read must not put a language
    // on a component — which it did, from detection's own shorter list.
    return await detectComponents({
      workspaceRoot,
      ignore: [...(config.ignore ?? []), ...languageFileDropPatterns(languages)],
      ...(config.respectGitignore === undefined
        ? {}
        : { respectGitignore: config.respectGitignore }),
    })
  } catch (error) {
    throw new CliError(`Failed to resolve components: ${errorMessage(error)}`, "config-error", {
      cause: error,
    })
  }
}

async function maybeWriteWorkspaceMd(
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
  await writeFile(path, md, "utf8")
  return path
}

async function maybeWriteComponentMd(
  format: "json" | "md" | "both",
  outputDir: string,
  ir: IR,
): Promise<string[]> {
  if (format === "json") return []
  const paths: string[] = []
  await mkdir(resolve(outputDir, COMPONENTS_DIRNAME), { recursive: true })
  for (const component of ir.components) {
    const symbolsInComponent = ir.symbols.filter((s) => s.component === component.id)
    const md = projectComponent({
      component,
      symbols: symbolsInComponent,
      dependencies: ir.dependencies,
    })
    const path = resolve(outputDir, COMPONENTS_DIRNAME, `${component.id}.md`)
    await writeFile(path, md, "utf8")
    paths.push(path)
  }
  return paths
}
