import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"
import { buildDiff, DiffError, type GitRenameMap, writeCanonicalDiff } from "@aburi/diff"
import {
  formatCallResolutionLine,
  projectDiff,
  projectDiffSummaryLine,
} from "@aburi/markdown-projection"
import type { IR, IRRef, NotComparedFile } from "@aburi/types"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME, resolveOutputDir } from "../artifact-paths"
import { configuredOutputDir, type PinnedConfig, pinConfig } from "../config-load"
import { CliError, errorCode, errorMessage } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { evaluateFailOn, type FailOnClause, formatTriggered, parseFailOn } from "../fail-on"
import { readGeneratorInfo } from "../generator-info"
import { readIR } from "../ir-io"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"
import { runScan, type ScanReport } from "./scan"

export type { WarnFn }

/**
 * Map a `DiffError` onto the CLI exit-code table (docs/design/cli-spec.md §9).
 *
 * Most codes describe something the reader can fix — IR schemas that disagree,
 * an out-of-range `lineFuzz`, a malformed IR, a repeated Symbol / Component id
 * or Dependency triple — so they surface as `config-error` (exit 2).
 * `slice-invariant-violated` is the one code that
 * cannot: it fires only when Aburi produced a Slice breaking its own
 * derivation rule (slice-view.md §7.4). Reporting that as a config error would
 * send a reader looking through `aburi.json` for a bug that is not there, the
 * same misdirection `assertRefResolvable` avoids by separating "git is
 * missing" from "that ref does not resolve".
 */
export function classifyDiffError(error: DiffError): CliError {
  switch (error.code) {
    case "schema-mismatch":
    case "invalid-line-fuzz":
    case "ir-shape-invalid":
    case "ir-identity-collision":
      return new CliError(error.message, "config-error", { cause: error })
    case "slice-invariant-violated":
      return internalDiffFault(error.message, error)
    default: {
      // A new `DiffErrorCode` is a type error here rather than a code that silently takes an
      // arm — and at runtime it degrades instead of throwing, because the compile-time check
      // protects this repo's build and not an installed tree: `@aburi/diff` and `@aburi/cli`
      // version independently, so a compiled switch can meet a code it never saw. Throwing
      // there would discard the one thing the reader needs, which is what the diff said.
      const unplaced: never = error.code
      return internalDiffFault(
        `${error.message} (diff error code ${JSON.stringify(unplaced)} has no exit code)`,
        error,
      )
    }
  }
}

/**
 * The report for a diff failure that is Aburi's own rather than the reader's.
 *
 * The instruction sits on its own line because nothing that reaches here ends in punctuation:
 * a thrown message run together with the next sentence is what a reader has to unpick.
 */
function internalDiffFault(detail: string, cause: unknown): CliError {
  return new CliError(
    `Internal error: ${detail}\n` +
      "This is a bug in Aburi, not in your configuration — please report it at " +
      "https://github.com/kage1020/Aburi/issues.",
    "runtime-error",
    { cause },
  )
}

export interface DiffOptions {
  cwd?: string
  refSpec?: string | null
  base?: string | null
  head?: string | null
  outputDir?: string
  format?: "json" | "md" | "both"
  failOn?: string
  configPath?: string
  compact?: boolean
  /** Injected git runner for tests. Defaults to a real `git` child process. */
  git?: GitRunner
  /** Non-fatal warning sink (defaults to `process.stderr.write`). */
  warn?: WarnFn
}

export interface GitRunner {
  run(
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }>
}

export interface DiffReport {
  diffJsonPath: string | null
  diffMdPath: string | null
  summaryLine: string
  /**
   * Head-side call-resolution census (call-resolution.md §8.1), rendered for
   * stdout. `null` when the head IR predates `stats.callResolution` — an older
   * artifact cannot be back-filled, and printing zeroes would claim a clean
   * graph the run never actually observed.
   */
  callResolutionLine: string | null
  triggered: { clause: FailOnClause; observed: number } | null
  /**
   * Sides whose own scan reported a fault — `ScanReport.exitCode` other than success, which
   * means a plugin threw while extracting a file, or the scan read too little of the workspace
   * to be believed (`cli-spec.md` §5.7). The two can hold on different sides at once, which is
   * why the warning built from this list says each side's cause rather than one about both.
   *
   * `null` in `--base` / `--head` mode, where this command ran no scan: that is not the same
   * answer as two clean scans, and an empty array would say it was. A document written by a
   * faulted scan still says so in `stats.skippedFiles`, and that is warned about rather than
   * gated on — see `warnOnRecordedFaults`.
   *
   * A non-empty list forces `exitCode` to `EXIT.GATE` with `triggered` still `null`, so this
   * is what a programmatic caller reads to tell the two causes apart instead of parsing
   * warnings.
   */
  faultedScans: readonly DiffSide[] | null
  exitCode: ExitCode
}

/**
 * Which revision a scan covered. The head is always the working tree, whatever the ref spec
 * calls it (§6.4), so the two are not interchangeable with the ref names.
 */
export type DiffSide = "base" | "head"

/**
 * `aburi diff` — two dispatch paths, both defined by `docs/design/cli-spec.md §6`:
 *
 * - `<base>..<head>` ref spec (§6.4). Both refs are validated with `git rev-parse
 *   --verify` before we touch the working tree; the base ref materialises via a
 *   temporary `git worktree add --detach`, `runScan` runs inside it, and the working
 *   tree itself is scanned as the head. The base's intermediate IR lives under
 *   `mkdtemp` so nothing is left in the user's repo, and cleanup runs in `finally`.
 *   The worktree's own directory is named after the head workspace's (§6.4 step 2),
 *   since Component detection reads that name — see `baseWorktreeLeaf`.
 *   NOTE: the head is always the working tree — a mismatched `<head>` label in the
 *   ref spec (e.g. `main..v1.1.0` when the checkout is `v1.0.0`) does NOT rescope the
 *   head scan; it only labels the report. This mirrors the design's "head is always
 *   the current checkout" contract but is easy to miss so we spell it out here.
 * - `--base <ir.json> --head <ir.json>` — parses both files and jumps directly to
 *   `buildDiff`. No git required.
 *
 * `--fail-on` is parsed once and evaluated post-diff; the first triggered clause maps to
 * `EXIT.GATE` with a stable diagnostic phrasing (§6.7). An empty `--fail-on` value
 * (from an unset shell variable, for example) is rejected by the parser rather than
 * silently disabling the CI gate.
 */
export async function runDiff(options: DiffOptions): Promise<DiffReport> {
  const cwd = options.cwd ?? process.cwd()
  const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`))
  const failOn = options.failOn === undefined ? [] : parseFailOn(options.failOn)
  // One pin for the whole command, and not one taken before something needs it.
  //
  // Eager would be simpler to read and wrong twice over: a `--base` / `--head` run that named
  // its own `--output-dir` consults no config at all today, and pinning walks the filesystem
  // and can raise `config-read-failed` on an EACCES that run would never have met. Lazy but
  // unmemoised is the state this replaces, where the destination and the scans each ran the
  // resolution list — same answer, since both anchor to `cwd`, but "decided once" was a
  // description of the intent rather than of the code.
  let pinned: PinnedConfig | null = null
  const pinConfigOnce = async (): Promise<PinnedConfig> => {
    pinned ??= await pinConfig(cwd, options.configPath)
    return pinned
  }
  // Before anything expensive. The destination is decided from `cwd` alone, and a run that
  // cannot be filed is a run not worth computing: resolved after the diff, a broken config
  // would cost two scans or two IR reads and then report `Failed to load Aburi config`, which
  // reads as "the comparison failed" when the comparison had already succeeded.
  //
  // The config is read only when the flag left the question open — a run that named its
  // destination must not be stopped by a file it never consults. The per-side scans of a ref
  // diff read the config for their own reasons, and write to an explicit temp directory
  // either way, which is a flag by another name.
  const outputDir = resolveOutputDir(
    cwd,
    options.outputDir,
    options.outputDir === undefined ? await configuredOutputDir(await pinConfigOnce()) : undefined,
  )
  const { baseIR, headIR, baseRef, headRef, gitRenames, scans } = await resolveIRs(
    options,
    cwd,
    pinConfigOnce,
    warn,
  )

  const generator = await readGeneratorInfo()
  // The narrowed return of `buildDiff` rather than a bare `DiffResult`: this command writes
  // the document, so it holds the fields the writer always emits, and re-widening here would
  // put an `?? []` back in front of the array whose whole point is that it is never absent.
  let diff: ReturnType<typeof buildDiff>
  try {
    diff = buildDiff({
      baseIR,
      headIR,
      base: irRef(baseRef, baseIR),
      head: irRef(headRef, headIR),
      generator,
      ...(gitRenames === null ? {} : { gitRenames }),
    })
  } catch (error) {
    if (error instanceof DiffError) throw classifyDiffError(error)
    throw error
  }

  await mkdir(outputDir, { recursive: true })
  const format = options.format ?? "both"

  let diffJsonPath: string | null = null
  let diffMdPath: string | null = null
  if (format !== "md") {
    diffJsonPath = resolve(outputDir, DIFF_JSON_FILENAME)
    const serialized = writeCanonicalDiff(diff, {
      format: options.compact ? "compact" : "pretty",
    })
    await writeFile(diffJsonPath, serialized, "utf8")
  }
  if (format !== "json") {
    diffMdPath = resolve(outputDir, DIFF_MD_FILENAME)
    await writeFile(diffMdPath, projectDiff(diff), "utf8")
  }

  // §6.6, from `@aburi/markdown-projection` rather than from a local copy: the two were
  // byte-identical, and a change to the format reached only one of them.
  const summaryLine = projectDiffSummaryLine(diff)
  const { firstTriggered } = evaluateFailOn(failOn, diff)
  const faultedScans =
    scans === null ? null : SIDES.filter((side) => scans[side].exitCode !== EXIT.SUCCESS)
  const exitCode: ExitCode =
    firstTriggered === null && (faultedScans === null || faultedScans.length === 0)
      ? EXIT.SUCCESS
      : EXIT.GATE

  // An IR written before `stats.callResolution` existed cannot be back-filled,
  // and printing zeroes would claim a clean call graph the run never observed.
  // Dropping the line silently is just as bad in the other direction: the
  // reviewer would read the Slice View below without knowing the one signal
  // that explains a suspicious singleton is missing. So: no stdout line, and
  // one stderr note saying why and how to get it back.
  const callResolution = headIR.stats.callResolution
  if (callResolution === undefined) {
    warn(
      `⚠ head IR has no stats.callResolution, so the call-resolution census is unavailable for this diff. Re-run \`aburi scan\` on the head revision to record it (call-resolution.md §8.1).`,
    )
  }
  warnOnUnenumerableLosses(baseIR, "base", warn)
  warnOnUnenumerableLosses(headIR, "head", warn)
  warnOnSymmetricLosses(diff.notCompared, warn)
  warnOnRecoverableParseErrors(scans, warn)
  if (scans === null) warnOnRecordedFaults({ base: baseIR, head: headIR }, warn)
  else warnOnScanFault(scans, faultedScans ?? [], warn)
  return {
    diffJsonPath,
    diffMdPath,
    summaryLine,
    callResolutionLine:
      callResolution === undefined ? null : formatCallResolutionLine(callResolution),
    triggered: firstTriggered,
    faultedScans,
    exitCode,
  }
}

/** Iteration order for the two sides, and the order they are reported in. */
const SIDES: readonly DiffSide[] = ["base", "head"]

/**
 * A file whose parse reported recoverable errors is in the IR, so nothing marks it.
 *
 * `stats.skippedFiles` covers the files that never arrived, and `buildDiff` turns their
 * Symbols into `unknown` rather than into deletions. A file the plugin kept is in neither
 * list — but a parse that reported errors may have skipped the declaration those errors were
 * in, and the Symbol set is then short with no file having gone missing. That moves `added`
 * and `removed` exactly like a real change, and no gate can tell the difference.
 *
 * Only the ref form can say this. `parseErrorCount` is a property of the scan, not of the
 * document it wrote, so `--base` / `--head` mode has no way to ask.
 */
function warnOnRecoverableParseErrors(scans: ScanPair | null, warn: WarnFn): void {
  if (scans === null) return
  const affected = SIDES.filter((side) => scans[side].parseErrorCount > 0)
  if (affected.length === 0) return
  const where = affected.map((side) => `${side} ${scans[side].parseErrorCount}`).join(", ")
  warn(
    `⚠ Files with recoverable parse errors (${where}) reached the IR rather than stats.skippedFiles, so nothing marks them as doubtful. ` +
      `Their Symbol sets can be short, which moves added / removed without a file having been skipped.`,
  )
}

/**
 * A scan that broke makes the diff evidence of nothing, whichever side broke.
 *
 * The counts are mostly not the problem: a withdrawn file is in `stats.skippedFiles`, which
 * `dependencySideView` reads into `lostFiles`, so its Symbols already classify as `unknown`
 * rather than as deletions. One gate reason escapes that — a file whose name the Document
 * cannot spell is in no list at all, so a file renamed into such a name between the two
 * revisions has its base Symbols read as deletions somebody made. Nothing here can repair it;
 * the document it would have to read is the one that cannot describe the file. The problem the
 * rest of this function is about is greenness: an
 * incident that `scan` refuses to exit `0` on (§5.6) should not turn green by being asked for
 * a diff instead of a scan. That covers the base side too, deliberately — a fault at the base
 * ref reddens every diff taken against it, which is the intended reading of "this comparison
 * has a broken half".
 *
 * The wording comes from what the scan reported rather than from the gate condition, which is
 * only `exitCode !== EXIT.SUCCESS`. A plugin exception was the sole reason that gated when this
 * was written and `runScan` said outright that others might follow; two more have, so the clause
 * reads all three. Naming any of them unconditionally would leave the exit code right and the
 * diagnosis wrong.
 *
 * One clause per faulted side, joined, rather than one sentence about a joined list of sides.
 * While a plugin exception was the only reason, every faulted side had thrown at least once and
 * a sentence about "the base and head scan" was true of both. It stopped being true the moment
 * two sides could fault for different reasons: a cross-side count, or the first side's fault,
 * stated about both is a false sentence — and this is the line a reader greps out of a CI log to
 * account for the exit code.
 */
function warnOnScanFault(scans: ScanPair, faultedScans: readonly DiffSide[], warn: WarnFn): void {
  if (faultedScans.length === 0) return
  const clauses = faultedScans.map((side) => `${side}: ${describeScanFault(scans[side])}`)
  warn(
    `⚠ ${clauses.join("; ")}. This run exits 3 even though the diff was written. ` +
      `Fix it, or the comparison is against a workspace one side could not read.`,
  )
}

/**
 * Why one scan did not exit clean, in the words of what it reported.
 *
 * Shorter than the lines `scan` prints for itself: those carry the consequence and where to
 * look, and both scans' reports are already on this stderr above this one (§5.6). This clause
 * exists to account for the exit code, so it names the cause and stops.
 *
 * A plugin exception comes first when one scan has more than one. It is the reason that says
 * something in the run is broken, and a scan that threw on every file it found has the coverage
 * fault as a consequence of it rather than as a second finding. That reading holds *within* a
 * scan and not across two, which is why it is decided here rather than by the caller.
 *
 * A cause that loses the contest still gets a trailing clause rather than silence. This is the
 * line a reader greps out of a CI log to account for the exit code, and an unnameable file
 * leaves no other trace anywhere — so the one reason that cannot be recovered later is the one
 * that must not be dropped for being second.
 *
 * The last arm is for a scan that gates for a reason this function has not been taught. It is
 * unreachable today — the three above are the whole of `runScan`'s gate, and the unnameable arm
 * fills the `fault === null` gap ahead of it — and saying nothing more than the exit code already
 * said is the honest answer to a cause we cannot name.
 */
function describeScanFault(scan: ScanReport): string {
  const thrown = scan.extractionFailures.length
  if (thrown > 0) return `a plugin exception withdrew ${thrown} file(s)`
  const fault = scan.coverageFault
  // Before "discovered no file to read" and after the other two faults, because the direction
  // of cause runs one way: an unnameable file leaves `totalFiles`, so a workspace whose whole
  // candidate set is unnameable discovers nothing and that fault is this one's consequence.
  // Leaving the denominator can only raise the parsed ratio, so it cannot produce either of
  // the other two — where those hold they are their own cause, and they are named instead.
  const unnameable = scan.unrepresentableFiles.length
  if (unnameable > 0 && (fault === null || fault.kind === "nothing-discovered")) {
    return `${unnameable} file(s) have names no Document path can spell`
  }
  // Only on the two arms it can co-occur with. The guard above already returned for the other
  // two, so appending it there would be a clause no input can produce.
  const alsoUnnameable =
    unnameable === 0 ? "" : ` (and ${unnameable} more have names no Document path can spell)`
  if (fault === null) return "it did not exit clean"
  switch (fault.kind) {
    case "nothing-discovered":
      return "it discovered no file to read"
    case "nothing-parsed":
      return `none of the ${fault.totalFiles} file(s) it found parsed${alsoUnnameable}`
    case "below-floor":
      return `${fault.parsedFiles} of ${fault.totalFiles} file(s) parsed, below the floor the workspace set${alsoUnnameable}`
  }
}

/**
 * File mode ran no scan, but the documents remember one.
 *
 * `stats.skippedFiles[].reason` persists `extraction-failed`, so `--base` / `--head` can see
 * that a plugin threw when a document was written even though it never watched it happen. Left
 * silent, a workspace that makes `aburi scan` exit 3 produced two IRs that diff clean — and
 * scan-in-one-job, diff-in-another is the shape `cli-spec.md` §6.4 recommends when git is not
 * available.
 *
 * It warns and does not gate. The fault already had its exit code, in the run that hit it;
 * failing here a second time would red a job for someone else's incident, on documents the
 * caller pinned deliberately. What the caller cannot do is not be told.
 */
function warnOnRecordedFaults(irs: Record<DiffSide, IR>, warn: WarnFn): void {
  for (const side of SIDES) {
    const thrown = (irs[side].stats.skippedFiles ?? []).filter(
      (file) => file.reason === "extraction-failed",
    )
    if (thrown.length === 0) continue
    const listed = thrown
      .slice(0, MAX_LISTED_RECORDED_FAULTS)
      .map((file) => file.path)
      .join(", ")
    const rest = thrown.length - MAX_LISTED_RECORDED_FAULTS
    warn(
      `⚠ ${side} IR records ${thrown.length} file(s) a plugin threw on: ${listed}${rest > 0 ? `, and ${rest} more` : ""}. ` +
        `The scan that wrote it exited 3; this diff does not, because the fault was reported where it happened.`,
    )
  }
}

/** Same reasoning as the scan's own listing cap: one broken plugin usually means every file. */
const MAX_LISTED_RECORDED_FAULTS = 10

/**
 * An IR that dropped files but predates `stats.skippedFiles` cannot say which ones.
 *
 * `buildDiff` needs the paths to tell a loss from a deletion, so with only the counts it
 * leaves every leftover classified as `added` / `removed` — which is the pre-`skippedFiles`
 * behaviour, and is exactly the confident-but-wrong report the field exists to prevent. It
 * cannot invent the list: guessing from `totalFiles > parsedFiles` would attach the doubt to
 * whichever Symbols happened to be missing.
 *
 * So the diff says nothing wrong and the CLI says what it could not check. Both sides are
 * examined, because a base written by an older scan makes phantom `added` entries the same
 * way a head makes phantom `removed` ones.
 */
function warnOnUnenumerableLosses(ir: IR, side: "base" | "head", warn: (m: string) => void): void {
  if (ir.stats.skippedFiles !== undefined) return
  const unparsed = ir.stats.totalFiles - ir.stats.parsedFiles
  if (unparsed <= 0) return
  const consequence = side === "head" ? "removed" : "added"
  warn(
    `⚠ ${side} IR reports ${unparsed} file(s) it did not parse but has no stats.skippedFiles to name them, so this diff cannot tell a lost file from a deleted one. Symbols from those files are reported as ${consequence}. Re-run \`aburi scan\` on the ${side} revision to record the list.`,
  )
}

/**
 * Files neither revision analysed produce no `unknown` entry, so nothing at the Symbol level
 * mentions them.
 *
 * `unknown` is derived from the matcher's leftovers: a Symbol one document has and the other
 * lacks. When a file is skipped on both sides there are no Symbols from it anywhere and no
 * leftovers, so no status can carry the loss. The document says it one level up, in
 * `notCompared[]` (`diff-algorithm.md` §6.3), and this line is the cover note for the reader
 * watching the command rather than reading the file it wrote.
 *
 * Deliberately shorter than the artifact: a count, a capped list of paths, and no reasons,
 * because a terminal line that grows with the size of a workspace's blind spot stops being
 * read. It points at the field instead, which is where the pair of reasons lives.
 *
 * Reads the array the document carries rather than intersecting the two skip lists again.
 * `buildDiff` computes it once from the side views its own Symbol classification uses, and a
 * second implementation here would be a second answer to "which files did neither side read",
 * with nothing to detect the two drifting apart.
 */
function warnOnSymmetricLosses(notCompared: readonly NotComparedFile[], warn: WarnFn): void {
  if (notCompared.length === 0) return
  const listed = notCompared
    .slice(0, MAX_LISTED_SYMMETRIC_LOSSES)
    .map((f) => f.path)
    .join(", ")
  const rest = notCompared.length - MAX_LISTED_SYMMETRIC_LOSSES
  warn(
    `⚠ ${notCompared.length} file(s) were skipped by both scans; see notCompared[] in diff.json: ${listed}${rest > 0 ? `, and ${rest} more` : ""}.`,
  )
}

/**
 * How many symmetrically-lost paths are named before the list is summarised. A workspace
 * whose config drops a whole generated directory hits this on every diff, and the list is
 * then the directory rather than a signal.
 */
const MAX_LISTED_SYMMETRIC_LOSSES = 10

/** Trigger phrasing so the CLI wrapper can pipe it to stderr. */
export function formatFailOnMessage(trig: NonNullable<DiffReport["triggered"]>): string {
  return formatTriggered(trig.clause, trig.observed)
}

interface RefSpec {
  base: string
  head: string
}

/**
 * `<base>..<head>`, split at the first separator rather than at every `..` (§6.3).
 *
 * `"main...HEAD".split("..")` is `["main", ".HEAD"]` — two parts, both non-empty, so the
 * three-dot form passed the syntax check and the run continued with `.HEAD` as the head ref.
 * What the reader then saw was a git failure naming a ref they never typed (`Head ref '.HEAD'
 * could not be resolved…`, exit 1), for an input §6.5 classifies as a syntax violation (exit
 * 2). Three-dot is a realistic input: it is the form in a GitHub compare URL and in
 * `git diff a...b`.
 *
 * So the separator is located once and the dot run measured, which lets the three-dot case be
 * named for what it is instead of falling into the generic message. `aburi diff` compares the
 * two revisions directly and has no merge-base form, so the message says that and hands over
 * the command that resolves one — a `git merge-base` the caller substitutes themselves,
 * because resolving it here would silently answer a different question than the one asked.
 *
 * Both sides are checked for emptiness before the dot run is judged, so `main...` reads as a
 * missing head ref rather than as a three-dot spec whose suggested rewrite is `main..`.
 */
function parseRefSpec(spec: string): RefSpec {
  const separator = spec.indexOf("..")
  if (separator === -1) throw malformedRefSpec(spec)
  // The whole run of dots, so `a...b` is one separator the caller spelled wrong rather than a
  // `..` followed by a ref whose name begins with a dot (git refuses those anyway).
  let afterDots = separator + 2
  while (spec[afterDots] === ".") afterDots++
  const base = spec.slice(0, separator)
  const head = spec.slice(afterDots)
  if (base.length === 0 || head.length === 0) {
    throw new CliError(
      `diff argument "${spec}" must contain non-empty base and head refs on either side of "..".`,
      "input-error",
    )
  }
  if (afterDots - separator === 3) {
    throw new CliError(
      `diff argument "${spec}" uses the three-dot form. aburi diff compares the two revisions directly, so write it as "${base}..${head}". To compare the head against the merge base instead, resolve that yourself: aburi diff "$(git merge-base ${base} ${head})..${head}".`,
      "input-error",
    )
  }
  // A longer dot run, or a second separator (`a..b..c`): neither names two refs, and neither
  // has a rewrite worth guessing at.
  if (afterDots - separator !== 2 || head.includes("..")) throw malformedRefSpec(spec)
  return { base, head }
}

function malformedRefSpec(spec: string): CliError {
  return new CliError(
    `diff argument "${spec}" is not a valid ref spec. Use <base>..<head> (e.g. main..HEAD) or supply --base and --head with IR paths.`,
    "input-error",
  )
}

type ScanPair = Record<DiffSide, ScanReport>

interface ResolvedIRs {
  baseIR: IR
  headIR: IR
  baseRef: string
  headRef: string
  gitRenames: GitRenameMap | null
  /** The two scans this command ran, or `null` when both documents came off disk. */
  scans: ScanPair | null
}

async function resolveIRs(
  options: DiffOptions,
  cwd: string,
  pinConfigOnce: () => Promise<PinnedConfig>,
  warn: WarnFn,
): Promise<ResolvedIRs> {
  if (options.refSpec !== undefined && options.refSpec !== null && options.refSpec.length > 0) {
    if (options.base !== undefined && options.base !== null) {
      throw new CliError(
        `--base cannot be combined with a ref spec argument. Use one or the other.`,
        "input-error",
      )
    }
    return resolveViaGit(options, cwd, parseRefSpec(options.refSpec), pinConfigOnce, warn)
  }
  if (options.base === undefined || options.base === null || options.base.length === 0) {
    throw new CliError(
      `aburi diff needs either <base>..<head> or --base <ir.json> --head <ir.json>.`,
      "input-error",
    )
  }
  if (options.head === undefined || options.head === null || options.head.length === 0) {
    throw new CliError(`--base was supplied without a matching --head <ir.json>.`, "input-error")
  }
  const baseIR = await readIR(resolve(cwd, options.base))
  const headIR = await readIR(resolve(cwd, options.head))
  return {
    baseIR,
    headIR,
    baseRef: options.base,
    headRef: options.head,
    gitRenames: null,
    scans: null,
  }
}

async function resolveViaGit(
  options: DiffOptions,
  cwd: string,
  spec: RefSpec,
  pinConfigOnce: () => Promise<PinnedConfig>,
  warn: WarnFn,
): Promise<ResolvedIRs> {
  const git = options.git ?? defaultGitRunner
  await assertRefResolvable(git, cwd, spec.base, "base")
  await assertRefResolvable(git, cwd, spec.head, "head")
  await assertNotShallow(git, cwd)

  // Pinned before the worktree exists, and therefore against the caller's own directory.
  // §6.4 step 3 gives the base scan the *head* `aburi.json`: a config as of the base ref
  // would make any commit that edits one read as "the entire IR changed". Discovery from
  // inside the worktree returns the base copy, and so does a relative `--config`, so the
  // rule holds only if the answer is fixed here and handed to both scans.
  const pinnedConfig = await pinConfigOnce()
  // Two things read this, and both are "the base is interpreted through the head's view":
  // the name to materialise the base under (§6.4 step 2), and where a relative
  // `./plugins/*.mjs` ref in the head's config resolves from (§6.4.1.5, which pins the plugin
  // set to the head environment). The worktree materialises the base *sources*; it has no
  // claim on either.
  const headWorkspaceRoot = await resolveWorkspaceRoot(cwd)
  const tempParent = await mkdtemp(resolve(tmpdir(), "aburi-worktree-"))
  // Under a directory of its own, so the leaf below is free to be any name the head workspace
  // has — including `base-out` or `head-out`, which as siblings would be the temp run's own
  // output directories.
  const worktreeParent = resolve(tempParent, "base")
  const worktreeDir = resolve(worktreeParent, baseWorktreeLeaf(headWorkspaceRoot))
  const baseOutputDir = resolve(tempParent, "base-out")
  const headOutputDir = resolve(tempParent, "head-out")
  let baseIR: IR
  let headIR: IR
  let scans: ScanPair
  // Whether there is a worktree to clean up. `finally` ran `worktree remove` unconditionally,
  // so anything that threw before the checkout existed — a failing `worktree add`, and now the
  // `mkdir` above it — was reported first as a cleanup failure advising `git worktree prune`.
  // The reader followed that, watched it succeed against bookkeeping that was never written,
  // and only then reached the exception that actually ended the run.
  let worktreeAdded = false
  const renames = await collectRenames(git, cwd, spec, warn)
  try {
    // git creates the leading directories of a worktree path itself, so this is belt and
    // braces for the one level this run invented rather than something git needs.
    await mkdir(worktreeParent, { recursive: true })
    await git.run(["worktree", "add", "--detach", worktreeDir, spec.base], { cwd })
    worktreeAdded = true
    const baseReport = await runScanInDir(
      worktreeDir,
      options,
      baseOutputDir,
      warn,
      pinnedConfig,
      headWorkspaceRoot,
      { side: "base", ref: spec.base },
    )
    if (baseReport.irPath === null) {
      throw new CliError(`scan for base ref "${spec.base}" produced no IR file.`, "runtime-error")
    }
    baseIR = await readIR(baseReport.irPath)

    const headReport = await runScanInDir(
      cwd,
      options,
      headOutputDir,
      warn,
      pinnedConfig,
      headWorkspaceRoot,
      { side: "head" },
    )
    if (headReport.irPath === null) {
      throw new CliError("scan for head ref produced no IR file.", "runtime-error")
    }
    headIR = await readIR(headReport.irPath)
    scans = { base: baseReport, head: headReport }
  } finally {
    if (worktreeAdded) {
      try {
        await git.run(["worktree", "remove", "--force", worktreeDir], { cwd })
      } catch (error) {
        warn(
          `⚠ git worktree cleanup failed for "${worktreeDir}"; ${errorMessage(error)}. Consider running \`git worktree prune\`.`,
        )
      }
    }
    try {
      await rm(tempParent, { recursive: true, force: true })
    } catch (error) {
      // `force` swallows ENOENT and nothing else; EBUSY / EPERM / ENOTEMPTY still throw, and a
      // throw from `finally` replaces whatever exception was in flight — so a scan that failed
      // to produce an IR would be reported as an fs error against a temp directory the caller
      // never named. Leaving the directory behind is the lesser loss, and it is under `tmpdir`.
      warn(
        `⚠ Failed to remove the temporary directory "${tempParent}"; ${errorMessage(error)}. It can be deleted by hand.`,
      )
    }
  }

  return {
    baseIR,
    headIR,
    baseRef: spec.base,
    headRef: spec.head,
    gitRenames: renames,
    scans,
  }
}

/**
 * The directory name to materialise the base revision under: the head workspace's own leaf.
 *
 * Why it is not a fixed word is `cli-spec.md` §6.4 step 2 — one statement of the rule, where
 * the rest of the ref-diff contract is. In short: detection reads the directory name for a
 * Component rooted at the workspace root, so a constant here made the base side a different
 * Component from the head side. This function is only the two names that rule cannot use.
 *
 * The two are an empty leaf — `basename` of an absolute path, only at the filesystem root —
 * and `@`. `git worktree add` writes its bookkeeping under `.git/worktrees/<leaf>` and cannot
 * spell that one: it fails with `fatal: not a git repository: <repo>/.git/worktrees/@`, which
 * reads as the reader's own repository being broken. `@x`, `HEAD`, `a^b`, `~x` and `x.lock`
 * are all fine, so `@` alone is the exception.
 *
 * Substituting is safe rather than lucky, and for one reason covering both: a substitution can
 * only reinstate the defect by supplying a Component id that differs from the head's, and
 * neither of these leaves can supply an id at all. `toKebabCase` maps both to the empty string,
 * which `makeComponentId` rejects as `invalid-component-id` (`packages/core/src/component.ts`),
 * so where detection decides ids the head scan refuses the workspace and names the directory
 * that did it; where `components[]` declares them, no directory name is read on either side.
 * What is left for this default to be is a name git can create.
 */
function baseWorktreeLeaf(headWorkspaceRoot: string): string {
  const leaf = basename(headWorkspaceRoot)
  return leaf.length === 0 || leaf === "@" ? "base" : leaf
}

/**
 * What a scan covered, in the only two shapes there are.
 *
 * The head carries no ref because §6.4 scans the working tree whatever the ref spec calls it,
 * so `main..v1.1.0` from a `v1.0.0` checkout must not produce a `head ref "v1.1.0"` label. As
 * a union that mislabelling is unwritable rather than caught by a test.
 */
type ScanTarget = { side: "base"; ref: string } | { side: "head" }

function labelFor(target: ScanTarget): string {
  return target.side === "base" ? `base ref "${target.ref}"` : "head (working tree)"
}

/**
 * One scan of one side, reading the config both sides share.
 *
 * `pinnedConfig` replaces `options.configPath` rather than accompanying it. The two would
 * otherwise disagree for the base: the flag's value is relative to the caller's directory
 * and this scan runs in the worktree. `pluginRefRoot` is passed to both sides for the same
 * reason — it is a no-op for the head, whose workspace root it already is, and stating it
 * once keeps the two scans provably identical in everything but their sources.
 */
async function runScanInDir(
  cwd: string,
  options: DiffOptions,
  outputDir: string,
  warn: WarnFn,
  pinnedConfig: PinnedConfig,
  pluginRefRoot: string,
  target: ScanTarget,
): Promise<ScanReport> {
  const scanOptions: Parameters<typeof runScan>[0] = {
    cwd,
    outputDir,
    format: "json",
    incidents: { warn, label: labelFor(target) },
    pinnedConfig,
    pluginRefRoot,
    ...(options.compact === undefined ? {} : { compact: options.compact }),
  }
  return runScan(scanOptions)
}

/**
 * `git rev-parse --verify` fails distinguishably for two very different situations:
 *   1. `git` is not installed on the host (`ENOENT` spawn failure) — reporting this as
 *      "base ref not found" is a wrong-remediation nightmare in CI logs.
 *   2. `git` is installed but the ref cannot be resolved (bad name, shallow clone).
 * We split them so the user gets the correct next step for each.
 */
async function assertRefResolvable(
  git: GitRunner,
  cwd: string,
  ref: string,
  role: "base" | "head",
): Promise<void> {
  try {
    await git.run(["rev-parse", "--verify", ref], { cwd })
  } catch (error) {
    if (isGitMissing(error)) {
      throw new CliError(
        "git executable not found in PATH. aburi diff <base>..<head> requires a working git installation. Install git or use --base/--head with pre-generated IR files.",
        "runtime-error",
        { cause: error },
      )
    }
    const roleTag = role === "base" ? "Base" : "Head"
    throw new CliError(
      `${roleTag} ref '${ref}' could not be resolved. If this is a CI shallow clone, run: git fetch --deepen=50 origin ${ref}`,
      "runtime-error",
      { cause: error },
    )
  }
}

function isGitMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT"
}

async function assertNotShallow(git: GitRunner, cwd: string): Promise<void> {
  const { stdout } = await git.run(["rev-parse", "--is-shallow-repository"], { cwd })
  if (stdout.trim() === "true") {
    throw new CliError(
      "Repository is shallow. aburi diff requires base ref history. Run: git fetch --unshallow",
      "runtime-error",
    )
  }
}

/**
 * `git diff --find-renames --name-status -z` powers the diff engine's stage-2 rename map
 * (`diff-algorithm.md` §3.2, which is where the `-z` contract is stated and why).
 *
 * A failure here is non-fatal — the diff still runs, just without the rename hints — so it warns
 * on stderr instead of aborting, loudly enough that a reviewer noticing "moved -> removed +
 * added" churn can trace the cause.
 *
 * Three ways this comes back useless, and only one of them is an error. git can fail; the record
 * stream can be unreadable; and git can *succeed* having quietly given up on rename detection —
 * over `diff.renameLimit` it exits 0, writes a warning to stderr, and reports every move as a
 * `D` plus an `A`. That last one used to be invisible here, and it fires on exactly the large
 * refactor where stage 2 matters most.
 */
async function collectRenames(
  git: GitRunner,
  cwd: string,
  spec: RefSpec,
  warn: WarnFn,
): Promise<GitRenameMap | null> {
  let stdout: string
  try {
    const result = await git.run(
      ["diff", "--find-renames", "--name-status", "-z", `${spec.base}..${spec.head}`],
      { cwd },
    )
    stdout = result.stdout
    // A diagnostic on a run that exited 0 — `diff.renameLimit` exceeded, a file it could not
    // read. Nothing here can act on it, and the hints it costs are silent by construction: the
    // records parse, the map is merely emptier than the refactor was.
    if (result.stderr.trim().length > 0) {
      warn(
        `⚠ git reported while collecting renames for ${spec.base}..${spec.head}: ${result.stderr.trim()}. ` +
          `Rename hints may be missing (raise diff.renameLimit if it says so); moves without one are reported as removed + added.`,
      )
    }
  } catch (error) {
    warn(
      `⚠ Failed to collect git renames (${errorMessage(error)}); the diff will treat renamed files as removed + added.`,
    )
    return null
  }
  // Outside the `try`, so a defect in the parser is never reported as git having failed.
  const parsed = parseRenameRecords(stdout)
  if (!parsed.ok) {
    warn(
      `⚠ git diff --name-status -z for ${spec.base}..${spec.head} produced a record this parser could not read ` +
        `(field ${parsed.index}: ${describeBadField(parsed.field)}); the diff will treat renamed files as removed + added.`,
    )
    return null
  }
  return parsed.renames
}

/** A field goes into a warning quoted and capped: it is a path, so it can carry control bytes. */
function describeBadField(field: string): string {
  const quoted = JSON.stringify(field)
  return quoted.length <= MAX_REPORTED_FIELD_LENGTH
    ? quoted
    : `${quoted.slice(0, MAX_REPORTED_FIELD_LENGTH)}…`
}

const MAX_REPORTED_FIELD_LENGTH = 120

/**
 * A `--name-status` status field: one letter, and on `R` / `C` a similarity score after it.
 *
 * Matching the score rather than assuming a one-character field is what keeps the shape check
 * below honest about what git actually writes (`R094`, not `R`).
 */
const NAME_STATUS_FIELD = /^[A-Z]\d*$/

/**
 * What the reader made of the stream: the renames, or where it stopped being readable.
 *
 * The failure carries its position because the caller has to write the warning somebody reads in
 * a CI log, and "could not read the output" with nothing else in it is a dead end for whoever
 * has to reproduce it.
 */
export type RenameRecords =
  | { ok: true; renames: GitRenameMap }
  | { ok: false; index: number; field: string }

/**
 * NUL-separated `--name-status` records into `{oldPath: newPath}`.
 *
 * Under `-z` the output is a flat sequence of fields rather than lines: a status, then the one
 * path it applies to — or, for the two statuses that carry a second path, `R` (rename) and `C`
 * (copy), two of them. The record length is therefore decided by the status, and every field of
 * a record has to be consumed even when the record is not a rename: skipping a `C` by its status
 * alone leaves the reader one field short and every record after it misread. Only `R` enters the
 * map — a copy's source file is still there, so it is not a move.
 *
 * Paths are normalized to NFC because that is the form they are compared against:
 * `toRelativePosix` normalizes every `source.file`, and `matchStageGitRename` looks a path up in
 * this map with a bare `Map.get`. A repository holding a path decomposed (macOS with
 * `core.precomposeUnicode` off) would otherwise produce a map that cannot match anything — the
 * failure this whole reader exists to prevent, on the class of path it is about.
 *
 * A failure, not a partial map, when a field is not a status where one must be or the stream
 * stops mid-field. A desynced reader produces *plausible* pairs — a path read as a status, the
 * next path read as its target — and a wrong rename is worse for stage 2 than no rename at all:
 * it pairs two unrelated Symbols and reports the move as settled. The caller degrades to no hints
 * and says so, which is the fallback a `git` that failed outright already gets.
 */
export function parseRenameRecords(stdout: string): RenameRecords {
  const fields = stdout.split("\0")
  // `-z` *terminates* each field, so a complete stream ends in an empty tail and anything else
  // there is a stream that was cut mid-field — the one truncation that would otherwise read as a
  // whole record, mapping a rename onto a chopped path. Empty stdout, nothing changed between
  // the refs, is that tail and nothing else.
  const tail = fields.pop()
  if (tail !== "") return { ok: false, index: fields.length, field: tail ?? "" }
  const renames = new Map<string, string>()
  let index = 0
  while (index < fields.length) {
    const status = fields[index]
    if (status === undefined || !NAME_STATUS_FIELD.test(status)) {
      return { ok: false, index, field: status ?? "" }
    }
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1
    // A record the stream ends in the middle of is truncated output, not a record we can read.
    if (index + pathCount > fields.length - 1) return { ok: false, index, field: status }
    index += 1 + pathCount
    if (!status.startsWith("R")) continue
    const oldPath = fields[index - 2]
    const newPath = fields[index - 1]
    // Unreachable — the bounds check above is what makes both defined — but `fields` is indexed
    // under `noUncheckedIndexedAccess`, so the guard is what makes this typecheck.
    if (oldPath === undefined || newPath === undefined) return { ok: false, index, field: status }
    renames.set(oldPath.normalize("NFC"), newPath.normalize("NFC"))
  }
  return { ok: true, renames }
}

function irRef(refName: string, ir: IR): IRRef {
  return { ref: refName, irSchema: ir.$schema }
}

/**
 * Chunks are joined as bytes and decoded once: a stream splits wherever it splits, so decoding
 * each chunk on its own turns a multi-byte character that straddles two of them into U+FFFD.
 */
const defaultGitRunner: GitRunner = {
  async run(
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd: options?.cwd })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })
      child.on("error", rejectPromise)
      child.on("close", (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8")
        const stderr = Buffer.concat(stderrChunks).toString("utf8")
        if (code === 0) return resolvePromise({ stdout, stderr })
        // A killed git has a null code and a signal; "exited with code null" would drop the one
        // fact that explains it, and this string is what the caller puts in front of the user.
        const how =
          code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`
        rejectPromise(new Error(`git ${args.join(" ")} ${how}: ${stderr}`))
      })
    })
  },
}
