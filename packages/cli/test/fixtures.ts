import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { makeLanguageId } from "@aburi/core"
import type { ComponentId, IR, SliceId, SymbolId } from "@aburi/types"
import { EXIT, type GitRunner, reportScanIncidents, type ScanReport } from "../src"

export function symbolId(raw: string): SymbolId {
  return raw as SymbolId
}

export function componentId(raw: string): ComponentId {
  return raw as ComponentId
}

export function sliceId(raw: string): SliceId {
  return raw as SliceId
}

export function emptyIR(): IR {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
    generator: { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: { root: ".", managers: [], languages: [makeLanguageId("ts")] },
    components: [],
    symbols: [],
    dependencies: [],
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: 0,
      droppedSymbols: 0,
      effectPropagation: {
        sccCount: 0,
        maxSccSize: 0,
        propagatedEffectCount: 0,
        symbolsWithPropagatedEffects: 0,
      },
    },
  }
}

export async function writeTypeScriptWorkspace(directory: string, name: string): Promise<void> {
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify({ name, private: true }),
    "utf8",
  )
  await writeFile(
    resolve(directory, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
    }),
    "utf8",
  )
  await mkdir(resolve(directory, "src"), { recursive: true })
  await writeFile(resolve(directory, "src/quiet.ts"), "// declares nothing\n", "utf8")
}

export class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

export function scanReportWith(overrides: Partial<ScanReport>): ScanReport {
  return {
    irPath: null,
    workspaceMdPath: null,
    componentMdPaths: [],
    totalFiles: 0,
    parsedFiles: 0,
    keptSymbols: 0,
    droppedSymbols: 0,
    parseErrorFiles: [],
    parseErrorCount: 0,
    parseFailureCount: 0,
    timeoutCount: 0,
    skipped: [],
    extractionFailures: [],
    lspEnrichment: undefined,
    callResolutionLine: "",
    unresolvedCalls: [],
    configSource: null,
    configPinnedByCaller: false,
    workspaceRoot: "/repo",
    coverageFault: null,
    unrepresentableFiles: [],
    undeclaredVocab: [],
    vocabDiscoveredPath: null,
    unresolvedDeclarations: [],
    treeReleaseFailures: [],
    fellBackToSingleComponent: false,
    pluginNamedFrameworks: [],
    exitCode: EXIT.SUCCESS,
    ...overrides,
  }
}

export function incidentLinesFrom(report: ScanReport, label: string | null): string[] {
  const lines: string[] = []
  reportScanIncidents(report, (line) => lines.push(line), label)
  return lines
}

export interface GitOutput {
  stdout: string
  stderr: string
}

export function gitOutput(stdout = "", stderr = ""): GitOutput {
  return { stdout, stderr }
}

export interface RecordedGitCall {
  args: readonly string[]
  cwd: string | undefined
}

export interface FakeGitOptions {
  handlers?: Record<string, (args: readonly string[]) => GitOutput | Promise<GitOutput>>
  onWorktreeAdd?: (worktreeDir: string) => Promise<void> | void
  unmodelled?: "succeed" | "throw"
}

/**
 * A `git` far enough for `runDiff`'s ref mode: the commands `resolveViaGit` issues, and the two
 * more it asks when a ref does not resolve, are modelled with the answers of a healthy,
 * non-shallow, non-sparse repository with commits and no submodules, and every call is recorded.
 */
export function fakeGit(options: FakeGitOptions = {}): {
  runner: GitRunner
  calls: RecordedGitCall[]
} {
  const calls: RecordedGitCall[] = []
  const handlers: NonNullable<FakeGitOptions["handlers"]> = {
    "rev-parse --verify": () => gitOutput("abc\n"),
    "rev-parse --is-inside-work-tree": () => gitOutput("true\n"),
    "rev-list --all": () => gitOutput("abc\n"),
    "rev-parse --is-shallow-repository": () => gitOutput("false\n"),
    "config --bool": () => gitOutput("false\n"),
    "ls-files -z": () => gitOutput(),
    "diff --find-renames": () => gitOutput(),
    "worktree add": async (args) => {
      const worktreeDir = args[3]
      if (worktreeDir === undefined) {
        throw new Error(`fake git: "worktree add" without a path: ${args.join(" ")}`)
      }
      await options.onWorktreeAdd?.(worktreeDir)
      return gitOutput()
    },
    "worktree remove": () => gitOutput(),
    ...options.handlers,
  }
  const runner: GitRunner = {
    async run(args, runOptions) {
      calls.push({ args, cwd: runOptions?.cwd })
      const handler = handlers[args.slice(0, 2).join(" ")]
      if (handler !== undefined) return handler(args)
      if (options.unmodelled === "throw") {
        throw new Error(`fake git: unmodelled command: ${args.join(" ")}`)
      }
      return gitOutput()
    },
  }
  return { runner, calls }
}

const FIXTURE_UNSET_GIT_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
]

export function realGit(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: resolve(cwd, "absent-gitconfig"),
    GIT_CONFIG_SYSTEM: resolve(cwd, "absent-gitconfig"),
    GIT_AUTHOR_NAME: "Aburi Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Aburi Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  }
  for (const name of FIXTURE_UNSET_GIT_ENV) delete childEnv[name]
  Object.assign(childEnv, env)
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, env: childEnv })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out).toString("utf8"))
      else
        rejectPromise(
          new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString("utf8")}`),
        )
    })
  })
}

export async function probeRealGit(): Promise<unknown> {
  const probeDir = await mkdtemp(resolve(tmpdir(), "aburi-git-probe-"))
  try {
    await realGit(["--version"], probeDir)
    return null
  } catch (error) {
    return error
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
}
