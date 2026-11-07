import { spawnSync } from "node:child_process"
import { existsSync, rmSync, writeSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { availableParallelism, tmpdir } from "node:os"
import { basename, resolve } from "node:path"
import type { ScanProgress } from "@aburi/core"
import type { GitRenameMap } from "@aburi/diff"
import type { IR } from "@aburi/types"
import type { PinnedConfig } from "../config-load"
import type { LogLevel } from "../env"
import { CliError, errorMessage, internalFault } from "../errors"
import { assertNotShallow, assertNotSparse, assertRefResolvable } from "../git/preflight"
import { collectRenames } from "../git/renames"
import { defaultGitRunner, type GitRunner, gitChildEnv } from "../git/runner"
import { submoduleIgnorePatterns } from "../git/submodules"
import { readIR } from "../ir-io"
import type { LogWrite } from "../logger"
import type { DiffProgress } from "../progress"
import { cleanUpOnFatalSignal } from "../signal-cleanup"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"
import type { RefSpec } from "./diff-inputs"
import { runScan } from "./scan"
import { reportScanIncidents } from "./scan-incidents"
import type { ScanReport } from "./scan-report"
import { type PortableScanOptions, scanInThread, type ThreadedScan } from "./scan-thread"

export type DiffSide = "base" | "head"

export const SIDES: readonly DiffSide[] = ["base", "head"]

export type ScanPair = Record<DiffSide, ScanReport>

export interface ScannedRevisions {
  baseIR: IR
  headIR: IR
  gitRenames: GitRenameMap | null
  scans: ScanPair
}

export interface RevisionScanContext {
  cwd: string
  git: GitRunner | undefined
  compact: boolean | undefined
  logLevel: LogLevel | undefined
  pinConfigOnce: () => Promise<PinnedConfig>
  warn: WarnFn
  log: LogWrite
  progress: ((progress: DiffProgress) => void) | undefined
  parallelScans: boolean | undefined
}

type ScanTarget = { side: "base"; ref: string } | { side: "head" }

export async function scanRevisions(
  spec: RefSpec,
  context: RevisionScanContext,
): Promise<ScannedRevisions> {
  const { cwd, warn } = context
  const git = context.git ?? defaultGitRunner
  await assertRefResolvable(git, cwd, spec.base, "base")
  await assertRefResolvable(git, cwd, spec.head, "head")
  await assertNotShallow(git, cwd)
  await assertNotSparse(git, cwd)

  const pinnedConfig = await context.pinConfigOnce()
  const headWorkspaceRoot = await resolveWorkspaceRoot(cwd)
  const submoduleIgnore = await submoduleIgnorePatterns(git, headWorkspaceRoot, warn)
  const gitRenames = await collectRenames(git, cwd, spec, warn)
  const tempParent = await mkdtemp(resolve(tmpdir(), "aburi-worktree-"))
  const worktreeParent = resolve(tempParent, "base")
  const worktreeDir = resolve(worktreeParent, baseWorktreeLeaf(headWorkspaceRoot))

  const said = new Set<string>()
  const optionsFor = (dir: string, outputDir: string): PortableScanOptions => ({
    cwd: dir,
    command: "diff",
    outputDir,
    format: "json",
    pinnedConfig,
    pluginRefRoot: headWorkspaceRoot,
    ...(submoduleIgnore.length === 0 ? {} : { ignore: submoduleIgnore }),
    ...(context.compact === undefined ? {} : { compact: context.compact }),
    ...(context.logLevel === undefined ? {} : { logLevel: context.logLevel }),
  })
  const readBase = async (report: ScanReport): Promise<IR> => {
    reportScanIncidents(report, warn, labelFor({ side: "base", ref: spec.base }), said)
    if (report.workspaceRoot !== worktreeDir) {
      throw internalFault(
        ` while scanning base ref "${spec.base}"`,
        `the scan rooted at ${report.workspaceRoot} instead of the worktree ${worktreeDir}, so the two sides would describe different trees`,
        null,
      )
    }
    if (report.irPath === null) {
      throw new CliError(`scan for base ref "${spec.base}" produced no IR file.`, "runtime-error")
    }
    return readIR(report.irPath)
  }
  const readHead = async (report: ScanReport): Promise<IR> => {
    reportScanIncidents(report, warn, labelFor({ side: "head" }), said)
    if (report.irPath === null) {
      throw new CliError("scan for head ref produced no IR file.", "runtime-error")
    }
    return readIR(report.irPath)
  }

  let worktreeAdded = false
  const releaseSignals = cleanUpOnFatalSignal(() =>
    removeCheckoutSynchronously(cwd, worktreeDir, tempParent),
  )
  try {
    await mkdir(worktreeParent, { recursive: true })
    await git.run(["worktree", "add", "--detach", worktreeDir, spec.base], { cwd })
    worktreeAdded = true
    const base: SideScan = {
      options: optionsFor(worktreeDir, resolve(tempParent, "base-out")),
      read: readBase,
      ...progressOf("base", context.progress),
    }
    const head: SideScan = {
      options: optionsFor(cwd, resolve(tempParent, "head-out")),
      read: readHead,
      ...progressOf("head", context.progress),
    }
    const scanned =
      (context.parallelScans ?? availableParallelism() >= 2)
        ? await scanTogether(base, head, context.log, {
            name: `base ref "${spec.base}"`,
            log: context.log,
            ...(base.progress === undefined ? {} : { progress: base.progress }),
            warn,
          })
        : await scanInTurn(base, head, context.log)
    return { ...scanned, gitRenames }
  } finally {
    // Failures here only warn: a throw from `finally` would replace the error that ended the scan.
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
}

interface SideScan {
  options: PortableScanOptions
  read: (report: ScanReport) => Promise<IR>
  progress?: (progress: ScanProgress) => void
  /** Called once the side's scan has returned, whatever it returned. */
  scanned?: () => void
}

type ScannedSides = Omit<ScannedRevisions, "gitRenames">

function progressOf(
  side: DiffSide,
  report: ((progress: DiffProgress) => void) | undefined,
): Pick<SideScan, "progress" | "scanned"> {
  if (report === undefined) return {}
  return {
    progress: (progress) => report({ kind: "scan", side, progress }),
    scanned: () => report({ kind: "scanned", side }),
  }
}

/** `runScan` for one side on this thread, its end reported however it ended. */
async function scanHere(side: SideScan, log: LogWrite): Promise<ScanReport> {
  try {
    return await runScan({
      ...side.options,
      log,
      ...(side.progress === undefined ? {} : { progress: side.progress }),
    })
  } finally {
    side.scanned?.()
  }
}

async function scanInTurn(base: SideScan, head: SideScan, log: LogWrite): Promise<ScannedSides> {
  const baseScan = await scanHere(base, log)
  const baseIR = await base.read(baseScan)
  const headScan = await scanHere(head, log)
  const headIR = await head.read(headScan)
  return { baseIR, headIR, scans: { base: baseScan, head: headScan } }
}

/**
 * The base on a thread of its own while the head runs here. What the run says, and which failure
 * ends it, is what `scanInTurn` would have: the head's log is held until the base is through, and
 * a base that fails waits for the head and discards it, as the head would never have started.
 */
async function scanTogether(
  base: SideScan,
  head: SideScan,
  log: LogWrite,
  baseThread: ThreadedScan,
): Promise<ScannedSides> {
  const headLog = heldLog(log)
  const headScan = scanHere(head, headLog.write)
  const headStopped = headScan.then(
    () => undefined,
    () => undefined,
  )
  let baseScan: ScanReport
  let baseIR: IR
  try {
    try {
      baseScan = await scanInThread(base.options, baseThread)
    } finally {
      base.scanned?.()
    }
    baseIR = await base.read(baseScan)
  } catch (error) {
    await headStopped
    throw error
  }
  headLog.release()
  const headReport = await headScan
  const headIR = await head.read(headReport)
  return { baseIR, headIR, scans: { base: baseScan, head: headReport } }
}

function heldLog(log: LogWrite): { write: LogWrite; release: () => void } {
  let held: Parameters<LogWrite>[] | null = []
  return {
    write: (line, level) => {
      if (held === null) log(line, level)
      else held.push([line, level])
    },
    release: () => {
      for (const [line, level] of held ?? []) log(line, level)
      held = null
    },
  }
}

function removeCheckoutSynchronously(cwd: string, worktreeDir: string, tempParent: string): void {
  // Read first, so a checkout the `finally` already removed is not reported as a failed remove.
  const hadCheckout = existsSync(worktreeDir)
  const removal = spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
    cwd,
    env: gitChildEnv(),
    stdio: "ignore",
  })
  if (hadCheckout && (removal.error !== undefined || removal.status !== 0)) {
    const why = removal.error?.message ?? `git exited ${removal.status ?? removal.signal}`
    // No `git worktree prune`: it would also remove prunable worktrees other people or tools made.
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
}

function reportFromSignal(message: string): void {
  // Not `warn`: its asynchronous write to a pipe is not flushed before the signal is re-raised.
  try {
    writeSync(2, `${message}\n`)
  } catch {
    // stderr may have gone with the terminal (SIGHUP); a throw would skip the rest of the cleanup.
  }
}

function baseWorktreeLeaf(headWorkspaceRoot: string): string {
  const leaf = basename(headWorkspaceRoot)
  return leaf.length === 0 || leaf === "@" ? "base" : leaf
}

function labelFor(target: ScanTarget): string {
  return target.side === "base" ? `base ref "${target.ref}"` : "head (working tree)"
}
