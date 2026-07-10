import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { buildDiff, DiffError, type GitRenameMap, writeCanonicalDiff } from "@aburi/diff"
import { projectDiff } from "@aburi/markdown-projection"
import type { DiffResult, IR, IRRef } from "@aburi/types"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME } from "../artifact-paths"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { evaluateFailOn, type FailOnClause, formatTriggered, parseFailOn } from "../fail-on"
import { readGeneratorInfo } from "../generator-info"
import { readIR } from "../ir-io"
import { runScan, type ScanReport } from "./scan"

/** Warning emitter for non-fatal diff-time observations (git errors, cleanup issues). */
export type WarnFn = (message: string) => void

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
  triggered: { clause: FailOnClause; observed: number } | null
  exitCode: ExitCode
}

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
  const [baseIR, headIR, baseRef, headRef, gitRenames] = await resolveIRs(options, cwd, warn)

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
    if (error instanceof DiffError) {
      throw new CliError(error.message, "config-error", { cause: error })
    }
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

  const summaryLine = renderSummaryLine(diff)
  const { firstTriggered } = evaluateFailOn(failOn, diff)
  const exitCode: ExitCode = firstTriggered === null ? EXIT.SUCCESS : EXIT.GATE

  return {
    diffJsonPath,
    diffMdPath,
    summaryLine,
    triggered: firstTriggered,
    exitCode,
  }
}

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

async function resolveIRs(
  options: DiffOptions,
  cwd: string,
  warn: WarnFn,
): Promise<[IR, IR, string, string, GitRenameMap | null]> {
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
  return [baseIR, headIR, options.base, options.head, null]
}

async function resolveViaGit(
  options: DiffOptions,
  cwd: string,
  spec: RefSpec,
  warn: WarnFn,
): Promise<[IR, IR, string, string, GitRenameMap | null]> {
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
  const renames = await collectRenames(git, cwd, spec, warn)
  try {
    await git.run(["worktree", "add", "--detach", worktreeDir, spec.base], { cwd })
    const baseReport = await runScanInDir(worktreeDir, options, baseOutputDir)
    if (baseReport.irPath === null) {
      throw new CliError(`scan for base ref "${spec.base}" produced no IR file.`, "runtime-error")
    }
    baseIR = await readIR(baseReport.irPath)

    const headReport = await runScanInDir(cwd, options, headOutputDir)
    if (headReport.irPath === null) {
      throw new CliError("scan for head ref produced no IR file.", "runtime-error")
    }
    headIR = await readIR(headReport.irPath)
  } finally {
    try {
      await git.run(["worktree", "remove", "--force", worktreeDir], { cwd })
    } catch (error) {
      warn(
        `git worktree cleanup failed for "${worktreeDir}"; ${errorMessage(error)}. Consider running \`git worktree prune\`.`,
      )
    }
    await rm(tempParent, { recursive: true, force: true })
  }

  return [baseIR, headIR, spec.base, spec.head, renames]
}

async function runScanInDir(
  cwd: string,
  options: DiffOptions,
  outputDir: string,
): Promise<ScanReport> {
  const scanOptions: Parameters<typeof runScan>[0] = {
    cwd,
    outputDir,
    format: "json",
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
      `Failed to collect git renames (${errorMessage(error)}); the diff will treat renamed files as removed + added.`,
    )
    return null
  }
}

function irRef(refName: string, ir: IR): IRRef {
  return { ref: refName, irSchema: ir.$schema }
}

function renderSummaryLine(diff: DiffResult): string {
  const s = diff.summary
  return `+${s.added} -${s.removed} ~${s.changed} ↔${s.moved} ⤴${s.movedChanged}`
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
