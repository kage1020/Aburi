import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { buildDiff, DiffError, type GitRenameMap, writeCanonicalDiff } from "@aburi/diff"
import {
  formatCallResolutionLine,
  projectDiff,
  projectDiffSummaryLine,
} from "@aburi/markdown-projection"
import type { DiffResult, IR, IRRef } from "@aburi/types"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME } from "../artifact-paths"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { evaluateFailOn, type FailOnClause, formatTriggered, parseFailOn } from "../fail-on"
import { readGeneratorInfo } from "../generator-info"
import { readIR } from "../ir-io"
import type { WarnFn } from "../warn"
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
      return new CliError(
        `Internal error: ${error.message} This is a bug in Aburi, not in your configuration — ` +
          "please report it at https://github.com/kage1020/Aburi/issues.",
        "runtime-error",
        { cause: error },
      )
    default:
      return assertNever(error.code)
  }
}

/**
 * A new `DiffErrorCode` has to be placed in the table above rather than defaulting into
 * `config-error`, because the two outcomes blame different people: one sends the reader to
 * `aburi.json`, the other to the issue tracker.
 */
function assertNever(code: never): never {
  throw new Error(`Unhandled DiffErrorCode: ${JSON.stringify(code)}`)
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
   * today means a plugin threw while extracting a file.
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
  const { baseIR, headIR, baseRef, headRef, gitRenames, scans } = await resolveIRs(
    options,
    cwd,
    warn,
  )

  const generator = await readGeneratorInfo()
  let diff: DiffResult
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

  const outputDir = resolve(cwd, options.outputDir ?? "out")
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
  warnOnSymmetricLosses(baseIR, headIR, warn)
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
 * The counts are not the problem — a withdrawn file is in `stats.skippedFiles`, so its
 * Symbols already classify as `unknown` rather than as deletions. The problem is greenness: an
 * incident that `scan` refuses to exit `0` on (§5.6) should not turn green by being asked for
 * a diff instead of a scan. That covers the base side too, deliberately — a fault at the base
 * ref reddens every diff taken against it, which is the intended reading of "this comparison
 * has a broken half".
 *
 * The wording comes from `extractionFailures` rather than from the gate condition, which is
 * only `exitCode !== EXIT.SUCCESS`. A plugin exception is the sole reason that gates today and
 * `runScan` says outright that others may follow; naming it unconditionally would leave the
 * exit code right and the diagnosis wrong on the day a second one lands.
 */
function warnOnScanFault(scans: ScanPair, faultedScans: readonly DiffSide[], warn: WarnFn): void {
  if (faultedScans.length === 0) return
  const thrown = faultedScans.reduce((n, side) => n + scans[side].extractionFailures.length, 0)
  const cause =
    thrown > 0
      ? `A plugin exception withdrew ${thrown} file(s) during the ${faultedScans.join(" and ")} scan`
      : `The ${faultedScans.join(" and ")} scan did not exit clean`
  warn(
    `⚠ ${cause}, so this run exits 3 even though the diff was written. ` +
      `Fix it, or the comparison is against a workspace one side could not read.`,
  )
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
 * Files neither revision analysed produce no `unknown` entry, so nothing in the diff mentions
 * them.
 *
 * `unknown` is derived from the matcher's leftovers: a Symbol one document has and the other
 * lacks. When a file is skipped on both sides there are no Symbols from it anywhere, no
 * leftovers, and the diff is silent — while looking exactly like a diff that compared the
 * file and found it unchanged. Most skip reasons are deterministic properties of the file, so
 * symmetric loss is the *ordinary* case: a generated bundle over the size cap, a language no
 * plugin claims, a file that has been unparseable since before the branch.
 *
 * Naming them is all this can do from here. Deciding what an artifact should say about a file
 * neither side read is a change to the diff document, not to its cover note.
 */
function warnOnSymmetricLosses(baseIR: IR, headIR: IR, warn: (m: string) => void): void {
  const inBase = new Set((baseIR.stats.skippedFiles ?? []).map((f) => f.path))
  const both = (headIR.stats.skippedFiles ?? [])
    .map((f) => f.path)
    .filter((path) => inBase.has(path))
    .sort()
  if (both.length === 0) return
  const listed = both.slice(0, MAX_LISTED_SYMMETRIC_LOSSES).join(", ")
  const rest = both.length - MAX_LISTED_SYMMETRIC_LOSSES
  warn(
    `⚠ ${both.length} file(s) were skipped by both scans and are not represented in this diff: ${listed}${rest > 0 ? `, and ${rest} more` : ""}.`,
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

function parseRefSpec(spec: string): RefSpec {
  const parts = spec.split("..")
  if (parts.length !== 2) {
    throw new CliError(
      `diff argument "${spec}" is not a valid ref spec. Use <base>..<head> (e.g. main..HEAD) or supply --base and --head with IR paths.`,
      "input-error",
    )
  }
  const [base, head] = parts
  if (base === undefined || base.length === 0 || head === undefined || head.length === 0) {
    throw new CliError(
      `diff argument "${spec}" must contain non-empty base and head refs on either side of "..".`,
      "input-error",
    )
  }
  return { base, head }
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

async function resolveIRs(options: DiffOptions, cwd: string, warn: WarnFn): Promise<ResolvedIRs> {
  if (options.refSpec !== undefined && options.refSpec !== null && options.refSpec.length > 0) {
    if (options.base !== undefined && options.base !== null) {
      throw new CliError(
        `--base cannot be combined with a ref spec argument. Use one or the other.`,
        "input-error",
      )
    }
    return resolveViaGit(options, cwd, parseRefSpec(options.refSpec), warn)
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
  warn: WarnFn,
): Promise<ResolvedIRs> {
  const git = options.git ?? defaultGitRunner
  await assertRefResolvable(git, cwd, spec.base, "base")
  await assertRefResolvable(git, cwd, spec.head, "head")
  await assertNotShallow(git, cwd)

  const tempParent = await mkdtemp(resolve(tmpdir(), "aburi-worktree-"))
  const worktreeDir = resolve(tempParent, "base")
  const baseOutputDir = resolve(tempParent, "base-out")
  const headOutputDir = resolve(tempParent, "head-out")
  let baseIR: IR
  let headIR: IR
  let scans: ScanPair
  const renames = await collectRenames(git, cwd, spec, warn)
  try {
    await git.run(["worktree", "add", "--detach", worktreeDir, spec.base], { cwd })
    const baseReport = await runScanInDir(worktreeDir, options, baseOutputDir, warn, {
      side: "base",
      ref: spec.base,
    })
    if (baseReport.irPath === null) {
      throw new CliError(`scan for base ref "${spec.base}" produced no IR file.`, "runtime-error")
    }
    baseIR = await readIR(baseReport.irPath)

    const headReport = await runScanInDir(cwd, options, headOutputDir, warn, { side: "head" })
    if (headReport.irPath === null) {
      throw new CliError("scan for head ref produced no IR file.", "runtime-error")
    }
    headIR = await readIR(headReport.irPath)
    scans = { base: baseReport, head: headReport }
  } finally {
    try {
      await git.run(["worktree", "remove", "--force", worktreeDir], { cwd })
    } catch (error) {
      warn(
        `⚠ git worktree cleanup failed for "${worktreeDir}"; ${errorMessage(error)}. Consider running \`git worktree prune\`.`,
      )
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

async function runScanInDir(
  cwd: string,
  options: DiffOptions,
  outputDir: string,
  warn: WarnFn,
  target: ScanTarget,
): Promise<ScanReport> {
  const scanOptions: Parameters<typeof runScan>[0] = {
    cwd,
    outputDir,
    format: "json",
    incidents: { warn, label: labelFor(target) },
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
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
  if (typeof error !== "object" || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === "ENOENT"
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
 * `git diff --find-renames --name-status` powers the diff engine's stage-2 rename map.
 * A failure here is non-fatal — the diff will still run, just without the rename hints —
 * so we warn on stderr instead of aborting, but the warning is loud enough that a
 * reviewer noticing "moved -> removed + added" churn can trace the cause.
 */
async function collectRenames(
  git: GitRunner,
  cwd: string,
  spec: RefSpec,
  warn: WarnFn,
): Promise<GitRenameMap | null> {
  try {
    const { stdout } = await git.run(
      ["diff", "--find-renames", "--name-status", `${spec.base}..${spec.head}`],
      { cwd },
    )
    const map = new Map<string, string>()
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.split(/\s+/)
      if (parts.length < 3) continue
      const status = parts[0]
      if (status === undefined || !status.startsWith("R")) continue
      const oldPath = parts[1]
      const newPath = parts[2]
      if (oldPath === undefined || newPath === undefined) continue
      map.set(oldPath, newPath)
    }
    return map
  } catch (error) {
    warn(
      `⚠ Failed to collect git renames (${errorMessage(error)}); the diff will treat renamed files as removed + added.`,
    )
    return null
  }
}

function irRef(refName: string, ir: IR): IRRef {
  return { ref: refName, irSchema: ir.$schema }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

const defaultGitRunner: GitRunner = {
  async run(
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd: options?.cwd })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })
      child.on("error", rejectPromise)
      child.on("close", (code) => {
        if (code === 0) resolvePromise({ stdout, stderr })
        else rejectPromise(new Error(`git ${args.join(" ")} exited with code ${code}: ${stderr}`))
      })
    })
  },
}
