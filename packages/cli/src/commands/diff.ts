import { spawn, spawnSync } from "node:child_process"
import { existsSync, rmSync, writeSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { buildDiff, DiffError, type GitRenameMap, writeCanonicalDiff } from "@aburi/diff"
import {
  formatCallResolutionLine,
  projectDiff,
  projectDiffSummaryLine,
} from "@aburi/markdown-projection"
import type { IR, IRRef, NotComparedFile } from "@aburi/types"
import {
  DIFF_FULL_MD_FILENAME,
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  resolveOutputDir,
} from "../artifact-paths"
import { configuredOutputDir, type PinnedConfig, pinConfig } from "../config-load"
import { CliError, errorCode, errorMessage, internalFault, unplacedErrorCode } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { evaluateFailOn, type FailOnClause, formatTriggered, parseFailOn } from "../fail-on"
import { pathExists } from "../fs-probe"
import { readGeneratorInfo } from "../generator-info"
import { readIR } from "../ir-io"
import { joinCapped } from "../listing"
import { createOutputDir, removeOutputFile, writeOutputFile } from "../output-file"
import { cleanUpOnFatalSignal } from "../signal-cleanup"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"
import { runScan, type ScanReport } from "./scan"

export type { WarnFn }

export function classifyDiffError(error: DiffError): CliError {
  switch (error.code) {
    case "schema-mismatch":
    case "invalid-line-fuzz":
    case "ir-shape-invalid":
    case "ir-identity-collision":
      return new CliError(error.message, "config-error", { cause: error })
    case "slice-invariant-violated":
      return internalFault("", error.message, error)
    default:
      return unplacedErrorCode("", "diff", error, error.code)
  }
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
  maxBytes?: number
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
  diffFullMdPath: string | null
  summaryLine: string
  callResolutionLine: string | null
  triggered: { clause: FailOnClause; observed: number } | null
  faultedScans: readonly DiffSide[] | null
  exitCode: ExitCode
}

export type DiffSide = "base" | "head"

export async function runDiff(options: DiffOptions): Promise<DiffReport> {
  const cwd = options.cwd ?? process.cwd()
  const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`))
  const failOn = options.failOn === undefined ? [] : parseFailOn(options.failOn)
  if (
    options.maxBytes !== undefined &&
    (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0)
  ) {
    throw new CliError(
      `--max-bytes must be a positive integer (got ${String(options.maxBytes)}).`,
      "input-error",
    )
  }
  let pinned: PinnedConfig | null = null
  const pinConfigOnce = async (): Promise<PinnedConfig> => {
    pinned ??= await pinConfig(cwd, options.configPath)
    return pinned
  }
  const inputs = chooseInputs(options)
  const outputDir = resolveOutputDir(
    cwd,
    options.outputDir,
    options.outputDir === undefined ? await configuredOutputDir(await pinConfigOnce()) : undefined,
  )
  await createOutputDir("diff", outputDir)
  await removeOutputFile({
    command: "diff",
    artefact: "the diff JSON",
    path: resolve(outputDir, DIFF_JSON_FILENAME),
  })
  await removeOutputFile({
    command: "diff",
    artefact: "the diff Markdown",
    path: resolve(outputDir, DIFF_MD_FILENAME),
  })
  const fullMdPath = resolve(outputDir, DIFF_FULL_MD_FILENAME)
  await removeOutputFile({
    command: "diff",
    artefact: "the uncapped diff Markdown",
    path: fullMdPath,
  })
  const { baseIR, headIR, baseRef, headRef, gitRenames, scans } = await resolveIRs(
    inputs,
    options,
    cwd,
    pinConfigOnce,
    warn,
  )

  const generator = await readGeneratorInfo()
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

  const format = options.format ?? "both"

  let diffJsonPath: string | null = null
  let diffMdPath: string | null = null
  if (format !== "md") {
    diffJsonPath = resolve(outputDir, DIFF_JSON_FILENAME)
    let serialized: string
    try {
      serialized = writeCanonicalDiff(diff, {
        format: options.compact ? "compact" : "pretty",
      })
    } catch (error) {
      throw new CliError(
        `Failed to serialize the diff for ${diffJsonPath}: ${errorMessage(error)}`,
        "config-error",
        { cause: error },
      )
    }
    await writeOutputFile(
      { command: "diff", artefact: "the diff JSON", path: diffJsonPath },
      serialized,
    )
  }
  if (format === "json" && options.maxBytes !== undefined) {
    warn(
      `⚠ --max-bytes has no effect under --format json: the cap applies to ${DIFF_MD_FILENAME}, which this run does not write.`,
    )
  }
  let diffFullMdPath: string | null = null
  if (format !== "json") {
    diffMdPath = resolve(outputDir, DIFF_MD_FILENAME)
    const uncapped = projectDiff(diff)
    let markdown = uncapped
    if (options.maxBytes !== undefined && Buffer.byteLength(uncapped, "utf8") > options.maxBytes) {
      await writeOutputFile(
        { command: "diff", artefact: "the uncapped diff Markdown", path: fullMdPath },
        uncapped,
      )
      diffFullMdPath = fullMdPath
      markdown = projectDiff(diff, {
        maxBytes: options.maxBytes,
        fullReportLocation: `\`${DIFF_FULL_MD_FILENAME}\` beside \`${DIFF_MD_FILENAME}\``,
      })
      const written = Buffer.byteLength(markdown, "utf8")
      if (written > options.maxBytes) {
        warn(
          `⚠ ${DIFF_MD_FILENAME} is ${written} bytes, over the ${options.maxBytes} requested: every section was dropped and the title and summary alone exceed it. Raise --max-bytes.`,
        )
      }
    }
    await writeOutputFile(
      { command: "diff", artefact: "the diff Markdown", path: diffMdPath },
      markdown,
    )
  }

  const summaryLine = projectDiffSummaryLine(diff)
  const { firstTriggered } = evaluateFailOn(failOn, diff)
  const faultedScans =
    scans === null ? null : SIDES.filter((side) => scans[side].exitCode !== EXIT.SUCCESS)
  const exitCode: ExitCode =
    firstTriggered === null && (faultedScans === null || faultedScans.length === 0)
      ? EXIT.SUCCESS
      : EXIT.GATE

  const callResolution = headIR.stats.callResolution
  if (callResolution === undefined) {
    warn(
      `⚠ head IR has no stats.callResolution, so the call-resolution census is unavailable for this diff. Re-run \`aburi scan\` on the head revision to record it (call-resolution.md).`,
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
    diffFullMdPath,
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

function warnOnScanFault(scans: ScanPair, faultedScans: readonly DiffSide[], warn: WarnFn): void {
  if (faultedScans.length === 0) return
  const clauses = faultedScans.map((side) => `${side}: ${describeScanFault(scans[side])}`)
  warn(
    `⚠ ${clauses.join("; ")}. This run exits 3 even though the diff was written. ` +
      `Fix it, or the comparison is against a workspace one side could not read.`,
  )
}

function describeScanFault(report: ScanReport): string {
  const withdrawn = report.extractionFailures.length
  if (withdrawn > 0) return `extraction withdrew ${withdrawn} file(s)`
  const fault = report.coverageFault
  const unnameable = report.unrepresentableFiles.length
  if (unnameable > 0 && (fault === null || fault.kind === "nothing-discovered")) {
    return `${unnameable} file(s) have names no Document path can spell`
  }
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

function warnOnRecordedFaults(irs: Record<DiffSide, IR>, warn: WarnFn): void {
  for (const side of SIDES) {
    const withdrawn = (irs[side].stats.skippedFiles ?? []).filter(
      (file) => file.reason === "extraction-failed",
    )
    if (withdrawn.length === 0) continue
    warn(
      `⚠ ${side} IR records ${withdrawn.length} file(s) withdrawn during extraction: ${joinCapped(withdrawn.map((file) => file.path))}. ` +
        `The scan that wrote it exited 3; this diff does not, because the fault was reported where it happened.`,
    )
  }
}

function warnOnUnenumerableLosses(ir: IR, side: DiffSide, warn: WarnFn): void {
  if (ir.stats.skippedFiles !== undefined) return
  const unparsed = ir.stats.totalFiles - ir.stats.parsedFiles
  if (unparsed <= 0) return
  const consequence = side === "head" ? "removed" : "added"
  warn(
    `⚠ ${side} IR reports ${unparsed} file(s) it did not parse but has no stats.skippedFiles to name them, so this diff cannot tell a lost file from a deleted one. Symbols from those files are reported as ${consequence}. Re-run \`aburi scan\` on the ${side} revision to record the list.`,
  )
}

function warnOnSymmetricLosses(notCompared: readonly NotComparedFile[], warn: WarnFn): void {
  if (notCompared.length === 0) return
  warn(
    `⚠ ${notCompared.length} file(s) were skipped by both scans; see notCompared[] in diff.json: ${joinCapped(notCompared.map(notComparedName))}.`,
  )
}

function notComparedName(file: NotComparedFile): string {
  return file.basePath === undefined ? file.path : `${file.basePath} → ${file.path}`
}

/** Trigger phrasing so the CLI wrapper can pipe it to stderr. */
export function formatFailOnMessage(triggered: NonNullable<DiffReport["triggered"]>): string {
  return formatTriggered(triggered.clause, triggered.observed)
}

interface RefSpec {
  base: string
  head: string
}

function parseRefSpec(spec: string): RefSpec {
  const separator = spec.indexOf("..")
  if (separator === -1) throw malformedRefSpec(spec)
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
  if (head.includes("..")) throw malformedRefSpec(spec)
  if (afterDots - separator === 3) {
    throw new CliError(
      `diff argument "${spec}" uses the three-dot form. aburi diff compares the two revisions directly, so write it as "${base}..${head}". To compare the head against the merge base instead, resolve it yourself with: git merge-base <base> <head>.`,
      "input-error",
    )
  }
  if (afterDots - separator !== 2) throw malformedRefSpec(spec)
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

type DiffInputs = { kind: "refs"; spec: RefSpec } | { kind: "files"; base: string; head: string }

function chooseInputs(options: DiffOptions): DiffInputs {
  if (options.refSpec !== undefined && options.refSpec !== null && options.refSpec.length > 0) {
    if (options.base !== undefined && options.base !== null) {
      throw new CliError(
        `--base cannot be combined with a ref spec argument. Use one or the other.`,
        "input-error",
      )
    }
    return { kind: "refs", spec: parseRefSpec(options.refSpec) }
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
  return { kind: "files", base: options.base, head: options.head }
}

async function resolveIRs(
  inputs: DiffInputs,
  options: DiffOptions,
  cwd: string,
  pinConfigOnce: () => Promise<PinnedConfig>,
  warn: WarnFn,
): Promise<ResolvedIRs> {
  if (inputs.kind === "refs") return resolveViaGit(options, cwd, inputs.spec, pinConfigOnce, warn)
  const baseIR = await readIR(resolve(cwd, inputs.base))
  const headIR = await readIR(resolve(cwd, inputs.head))
  return {
    baseIR,
    headIR,
    baseRef: inputs.base,
    headRef: inputs.head,
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
  await assertNotSparse(git, cwd)

  const pinnedConfig = await pinConfigOnce()
  const headWorkspaceRoot = await resolveWorkspaceRoot(cwd)
  const submoduleIgnore = await submodulePatterns(git, headWorkspaceRoot, warn)
  const renames = await collectRenames(git, cwd, spec, warn)
  const tempParent = await mkdtemp(resolve(tmpdir(), "aburi-worktree-"))
  const worktreeParent = resolve(tempParent, "base")
  const worktreeDir = resolve(worktreeParent, baseWorktreeLeaf(headWorkspaceRoot))
  const baseOutputDir = resolve(tempParent, "base-out")
  const headOutputDir = resolve(tempParent, "head-out")
  let baseIR: IR
  let headIR: IR
  let scans: ScanPair
  let worktreeAdded = false
  const releaseSignals = cleanUpOnFatalSignal(() => {
    const hadCheckout = existsSync(worktreeDir)
    const removal = spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
      cwd,
      env: gitChildEnv(),
      stdio: "ignore",
    })
    if (hadCheckout && (removal.error !== undefined || removal.status !== 0)) {
      const why = removal.error?.message ?? `git exited ${removal.status ?? removal.signal}`
      reportFromSignal(
        `⚠ git worktree cleanup failed for "${worktreeDir}"; ${why}. Consider running \`git worktree prune\`.`,
      )
    }
    try {
      rmSync(tempParent, { recursive: true, force: true })
    } catch (error) {
      reportFromSignal(
        `⚠ Failed to remove the temporary directory "${tempParent}"; ${errorMessage(error)}. It can be deleted by hand.`,
      )
    }
  })
  try {
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
      submoduleIgnore,
    )
    if (baseReport.workspaceRoot !== worktreeDir) {
      throw internalFault(
        ` while scanning base ref "${spec.base}"`,
        `the scan rooted at ${baseReport.workspaceRoot} instead of the worktree ${worktreeDir}, so the two sides would describe different trees`,
        null,
      )
    }
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
      submoduleIgnore,
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
      warn(
        `⚠ Failed to remove the temporary directory "${tempParent}"; ${errorMessage(error)}. It can be deleted by hand.`,
      )
    }
    releaseSignals()
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

function baseWorktreeLeaf(headWorkspaceRoot: string): string {
  const leaf = basename(headWorkspaceRoot)
  return leaf.length === 0 || leaf === "@" ? "base" : leaf
}

type ScanTarget = { side: "base"; ref: string } | { side: "head" }

function labelFor(target: ScanTarget): string {
  return target.side === "base" ? `base ref "${target.ref}"` : "head (working tree)"
}

async function runScanInDir(
  cwd: string,
  options: DiffOptions,
  outputDir: string,
  warn: WarnFn,
  pinnedConfig: PinnedConfig,
  pluginRefRoot: string,
  target: ScanTarget,
  submoduleIgnore: readonly string[],
): Promise<ScanReport> {
  const scanOptions: Parameters<typeof runScan>[0] = {
    cwd,
    command: "diff",
    outputDir,
    format: "json",
    incidents: { warn, label: labelFor(target) },
    pinnedConfig,
    pluginRefRoot,
    ...(submoduleIgnore.length === 0 ? {} : { ignore: submoduleIgnore }),
    ...(options.compact === undefined ? {} : { compact: options.compact }),
  }
  return runScan(scanOptions)
}

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
    throw await diagnoseUnresolvedRef(git, cwd, ref, role, error)
  }
}

async function diagnoseUnresolvedRef(
  git: GitRunner,
  cwd: string,
  ref: string,
  role: "base" | "head",
  cause: unknown,
): Promise<CliError> {
  const prefix = `${role === "base" ? "Base" : "Head"} ref '${ref}' could not be resolved`
  const said = errorMessage(cause).trim()
  const outside = "Run aburi diff from inside one, or compare IR files with --base/--head."
  const unanswered = (): CliError =>
    new CliError(
      `${prefix}, and git would not say why. What it reported: ${said}`,
      "runtime-error",
      { cause },
    )

  const inside = await isInsideWorkTree(git, cwd)
  if (inside === null) {
    if (await gitRepositoryAbove(cwd)) return unanswered()
    return new CliError(
      `${prefix}: ${cwd} is not inside a git repository. ${outside} (${said})`,
      "input-error",
      { cause },
    )
  }
  if (!inside) {
    return new CliError(
      `${prefix}: ${cwd} is inside a git directory, not a working tree. ${outside} (${said})`,
      "input-error",
      { cause },
    )
  }
  const commits = await hasCommits(git, cwd)
  if (commits === null) return unanswered()
  if (!commits) {
    return new CliError(
      `${prefix}: the repository at ${cwd} has no commits yet, so there is no revision to compare. (${said})`,
      "input-error",
      { cause },
    )
  }
  return new CliError(
    `${prefix}: no such revision in this repository. Check the spelling, or fetch the branch first. (${said})`,
    "input-error",
    { cause },
  )
}

async function isInsideWorkTree(git: GitRunner, cwd: string): Promise<boolean | null> {
  try {
    const { stdout } = await git.run(["rev-parse", "--is-inside-work-tree"], { cwd })
    return stdout.trim() === "true"
  } catch {
    return null
  }
}

async function hasCommits(git: GitRunner, cwd: string): Promise<boolean | null> {
  try {
    const { stdout } = await git.run(["rev-list", "--all", "--max-count=1"], { cwd })
    return stdout.trim().length > 0
  } catch {
    return null
  }
}

async function gitRepositoryAbove(cwd: string): Promise<boolean> {
  if (process.env.GIT_DIR !== undefined) return true
  let directory = resolve(cwd)
  for (;;) {
    if (await pathExists(join(directory, ".git"))) return true
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
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

async function assertNotSparse(git: GitRunner, cwd: string): Promise<void> {
  const { stdout } = await git.run(
    ["config", "--bool", "--default", "false", "core.sparseCheckout"],
    { cwd },
  )
  if (stdout.trim() === "true") {
    throw new CliError(
      "Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable",
      "runtime-error",
    )
  }
}

async function submodulePatterns(
  git: GitRunner,
  workspaceRoot: string,
  warn: WarnFn,
): Promise<string[]> {
  const { stdout } = await git.run(["ls-files", "-z", "--stage"], { cwd: workspaceRoot })
  const paths = parseSubmodulePaths(stdout)
  if (paths.length === 0) return []
  warn(
    `⚠ Submodules detected: ${paths.join(", ")}. Submodule-aware diff is not yet supported, so their files are left out of both file scans. Component detection still walks them, so a workspace package inside one can still be reported as a Component added or removed.`,
  )
  return paths.map((path) => `${escapeGlob(path)}/**`)
}

export function parseSubmodulePaths(stdout: string): string[] {
  const paths = new Set<string>()
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t")
    if (tab === -1) continue
    if (!record.startsWith("160000 ")) continue
    paths.add(record.slice(tab + 1))
  }
  return [...paths].sort()
}

function escapeGlob(path: string): string {
  return path.replace(/[\\()[\]{}*?|!+@]/g, "\\$&")
}

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
    if (result.stderr.trim().length > 0) {
      warn(
        `⚠ git reported while collecting renames for ${spec.base}..${spec.head}: ${result.stderr.trim()}. ` +
          `Rename hints may be missing (raise diff.renameLimit if it says so); moves without one are reported as removed + added, ${RENAMED_AND_SKIPPED}.`,
      )
    }
  } catch (error) {
    warn(
      `⚠ Failed to collect git renames (${errorMessage(error)}); the diff will treat renamed files as removed + added, ${RENAMED_AND_SKIPPED}.`,
    )
    return null
  }
  // Outside the `try`, so a defect in the parser is never reported as git having failed.
  const parsed = parseRenameRecords(stdout)
  if (!parsed.ok) {
    warn(
      `⚠ git diff --name-status -z for ${spec.base}..${spec.head} produced a record this parser could not read ` +
        `(field ${parsed.index}: ${describeBadField(parsed.field)}); the diff will treat renamed files as removed + added, ${RENAMED_AND_SKIPPED}.`,
    )
    return null
  }
  return parsed.renames
}

const RENAMED_AND_SKIPPED =
  "and the Symbols of a renamed file one scan skipped as removed or added rather than unknown"

/** A field goes into a warning quoted and capped: it is a path, so it can carry control bytes. */
function describeBadField(field: string): string {
  const quoted = JSON.stringify(field)
  return quoted.length <= MAX_REPORTED_FIELD_LENGTH
    ? quoted
    : `${quoted.slice(0, MAX_REPORTED_FIELD_LENGTH)}…`
}

const MAX_REPORTED_FIELD_LENGTH = 120

const NAME_STATUS_FIELD = /^[A-Z]\d*$/

export type RenameRecords =
  | { ok: true; renames: GitRenameMap }
  | { ok: false; index: number; field: string }

export function parseRenameRecords(stdout: string): RenameRecords {
  const fields = stdout.split("\0")
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
    if (oldPath === undefined || newPath === undefined) return { ok: false, index, field: status }
    renames.set(oldPath.normalize("NFC"), newPath.normalize("NFC"))
  }
  return { ok: true, renames }
}

function irRef(refName: string, ir: IR): IRRef {
  return { ref: refName, irSchema: ir.$schema }
}

const UNINHERITED_GIT_ENV: readonly string[] = ["GIT_INDEX_FILE", "GIT_PREFIX"]

function reportFromSignal(message: string): void {
  try {
    writeSync(2, `${message}\n`)
  } catch {}
}

/** The environment a git command is spawned with: `env` without `UNINHERITED_GIT_ENV`. */
export function gitChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env }
  for (const name of UNINHERITED_GIT_ENV) delete child[name]
  return child
}

const defaultGitRunner: GitRunner = {
  async run(
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd: options?.cwd, env: gitChildEnv() })
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
        const how =
          code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`
        rejectPromise(new Error(`git ${args.join(" ")} ${how}: ${stderr}`))
      })
    })
  },
}
