import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { buildDiff, DiffError, type GitRenameMap, writeCanonicalDiff } from "@aburi/diff"
import { projectDiff } from "@aburi/markdown-projection"
import type { DiffResult, IR, IRRef } from "@aburi/types"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { evaluateFailOn, type FailOnClause, formatTriggered, parseFailOn } from "../fail-on"
import { runScan, type ScanReport } from "./scan"

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
 * §6 — `aburi diff`. Two dispatch paths:
 * - `<base>..<head>` ref spec — runs `git worktree add` for the base ref, executes
 *   `runScan` in the temporary worktree, then loads or scans the head IR. Cleans up on
 *   success and on error (§6.4 tail).
 * - `--base <ir.json> --head <ir.json>` — parses both files, jumps directly to
 *   `buildDiff`. No git required.
 *
 * `--fail-on` is parsed once and evaluated post-diff; the first triggered clause maps to
 * exit 3 with a stable diagnostic phrasing (§6.7).
 */
export async function runDiff(options: DiffOptions): Promise<DiffReport> {
  const cwd = options.cwd ?? process.cwd()
  const failOn = options.failOn === undefined ? [] : parseFailOn(options.failOn)
  const [baseIR, headIR, baseRef, headRef, gitRenames] = await resolveIRs(options, cwd)

  let diff: DiffResult
  try {
    diff = buildDiff({
      baseIR,
      headIR,
      base: irRef(baseRef, baseIR),
      head: irRef(headRef, headIR),
      generator: { name: "aburi", version: "0.0.0" },
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
    diffJsonPath = resolve(outputDir, "diff.json")
    const serialized = writeCanonicalDiff(diff, {
      format: options.compact ? "compact" : "pretty",
    })
    await writeFile(diffJsonPath, serialized, "utf8")
  }
  if (format !== "json") {
    diffMdPath = resolve(outputDir, "diff.md")
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
): Promise<[IR, IR, string, string, GitRenameMap | null]> {
  if (options.refSpec !== undefined && options.refSpec !== null && options.refSpec.length > 0) {
    if (options.base !== undefined && options.base !== null) {
      throw new CliError(
        `--base cannot be combined with a ref spec argument. Use one or the other.`,
        "input-error",
      )
    }
    return resolveViaGit(options, cwd, parseRefSpec(options.refSpec))
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

async function readIR(path: string): Promise<IR> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    throw new CliError(`Failed to read IR file "${path}": ${errorMessage(error)}`, "input-error", {
      cause: error,
    })
  }
  try {
    return JSON.parse(raw) as IR
  } catch (error) {
    throw new CliError(
      `IR file "${path}" is not valid JSON: ${errorMessage(error)}`,
      "input-error",
      { cause: error },
    )
  }
}

async function resolveViaGit(
  options: DiffOptions,
  cwd: string,
  spec: RefSpec,
): Promise<[IR, IR, string, string, GitRenameMap | null]> {
  const git = options.git ?? defaultGitRunner
  await assertRefResolvable(git, cwd, spec.base)
  await assertNotShallow(git, cwd)

  const tempParent = await mkdtemp(resolve(tmpdir(), "aburi-worktree-"))
  const worktreeDir = resolve(tempParent, "base")
  let baseIR: IR
  const renames = await collectRenames(git, cwd, spec)
  try {
    await git.run(["worktree", "add", "--detach", worktreeDir, spec.base], { cwd })
    const baseReport = await runScanInDir(worktreeDir, options)
    if (baseReport.irPath === null) {
      throw new CliError(`scan for base ref "${spec.base}" produced no IR file.`, "runtime-error")
    }
    baseIR = await readIR(baseReport.irPath)
  } finally {
    try {
      await git.run(["worktree", "remove", "--force", worktreeDir], { cwd })
    } catch {
      // Best-effort cleanup; the temp dir removal below still runs.
    }
    await rm(tempParent, { recursive: true, force: true })
  }

  const headReport = await runScanInDir(cwd, options)
  if (headReport.irPath === null) {
    throw new CliError("scan for head ref produced no IR file.", "runtime-error")
  }
  const headIR = await readIR(headReport.irPath)
  return [baseIR, headIR, spec.base, spec.head, renames]
}

async function runScanInDir(cwd: string, options: DiffOptions): Promise<ScanReport> {
  const scanOptions: Parameters<typeof runScan>[0] = {
    cwd,
    outputDir: resolve(cwd, "out-aburi-diff"),
    format: "json",
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.compact === undefined ? {} : { compact: options.compact }),
  }
  return runScan(scanOptions)
}

async function assertRefResolvable(git: GitRunner, cwd: string, ref: string): Promise<void> {
  try {
    await git.run(["rev-parse", "--verify", ref], { cwd })
  } catch (error) {
    throw new CliError(
      `Base ref '${ref}' not found. If this is a CI shallow clone, run: git fetch --deepen=50 origin ${ref}`,
      "runtime-error",
      { cause: error },
    )
  }
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

async function collectRenames(
  git: GitRunner,
  cwd: string,
  spec: RefSpec,
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
  } catch {
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
