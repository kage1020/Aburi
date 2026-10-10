import { spawnSync } from "node:child_process"
import { existsSync, rmSync, writeSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"
import type { GitRenameMap } from "@aburi/diff"
import type { IR } from "@aburi/types"
import type { PinnedConfig } from "../config-load"
import { CliError, errorMessage, internalFault } from "../errors"
import { assertNotShallow, assertNotSparse, assertRefResolvable } from "../git/preflight"
import { collectRenames } from "../git/renames"
import { defaultGitRunner, type GitRunner, gitChildEnv } from "../git/runner"
import { submoduleIgnorePatterns } from "../git/submodules"
import { readIR } from "../ir-io"
import { cleanUpOnFatalSignal } from "../signal-cleanup"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"
import type { RefSpec } from "./diff-inputs"
import { runScan } from "./scan"
import type { ScanReport } from "./scan-report"

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
  pinConfigOnce: () => Promise<PinnedConfig>
  warn: WarnFn
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

  const scanSide = (dir: string, outputDir: string, target: ScanTarget): Promise<ScanReport> =>
    runScan({
      cwd: dir,
      command: "diff",
      outputDir,
      format: "json",
      incidents: { warn, label: labelFor(target) },
      pinnedConfig,
      pluginRefRoot: headWorkspaceRoot,
      ...(submoduleIgnore.length === 0 ? {} : { ignore: submoduleIgnore }),
      ...(context.compact === undefined ? {} : { compact: context.compact }),
    })

  let worktreeAdded = false
  const releaseSignals = cleanUpOnFatalSignal(() =>
    removeCheckoutSynchronously(cwd, worktreeDir, tempParent),
  )
  try {
    await mkdir(worktreeParent, { recursive: true })
    await git.run(["worktree", "add", "--detach", worktreeDir, spec.base], { cwd })
    worktreeAdded = true
    const baseReport = await scanSide(worktreeDir, resolve(tempParent, "base-out"), {
      side: "base",
      ref: spec.base,
    })
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
    const baseIR = await readIR(baseReport.irPath)

    const headReport = await scanSide(cwd, resolve(tempParent, "head-out"), { side: "head" })
    if (headReport.irPath === null) {
      throw new CliError("scan for head ref produced no IR file.", "runtime-error")
    }
    const headIR = await readIR(headReport.irPath)
    return { baseIR, headIR, gitRenames, scans: { base: baseReport, head: headReport } }
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
}

function removeCheckoutSynchronously(cwd: string, worktreeDir: string, tempParent: string): void {
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
}

function reportFromSignal(message: string): void {
  try {
    writeSync(2, `${message}\n`)
  } catch {}
}

function baseWorktreeLeaf(headWorkspaceRoot: string): string {
  const leaf = basename(headWorkspaceRoot)
  return leaf.length === 0 || leaf === "@" ? "base" : leaf
}

function labelFor(target: ScanTarget): string {
  return target.side === "base" ? `base ref "${target.ref}"` : "head (working tree)"
}
