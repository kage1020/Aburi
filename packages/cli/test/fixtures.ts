import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { makeLanguageId } from "@aburi/core"
import type { ComponentId, IR, SliceId, SymbolId } from "@aburi/types"
import { EXIT, type GitRunner, reportScanIncidents, type ScanReport } from "../src"

/**
 * Id branding for CLI test fixtures.
 *
 * Fixtures are one of the documented boundary layers where an id is asserted rather than
 * constructed (ir-schema.md): these files hand-write whole IR documents, including ones
 * the producers could never emit, so routing them through `makeSymbolId` would make the
 * negative cases unwritable. Production code has no such escape — it reaches a branded id
 * only through the constructors and guards in `@aburi/core`.
 */
export function symbolId(raw: string): SymbolId {
  return raw as SymbolId
}

/** Component-id counterpart of `symbolId`, same rationale. */
export function componentId(raw: string): ComponentId {
  return raw as ComponentId
}

/** Slice-id counterpart of `symbolId`, same rationale. */
export function sliceId(raw: string): SliceId {
  return raw as SliceId
}

/**
 * A schema-valid IR that describes nothing: the smallest document `readIR` accepts, for tests
 * whose subject is what a command does around the comparison rather than the comparison.
 */
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

/**
 * The smallest workspace `aburi scan` reads for real: a manifest, a config naming
 * `lang-typescript`, and one source file that parses and declares nothing. Every report of it
 * carries zero Symbols while the scan still read the repository — the distinction the coverage
 * gate rests on, since a workspace where nothing parsed is not a success.
 */
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

/** A writable stream that keeps what was written, for capturing `runCli`'s stdout / stderr. */
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

/** A clean, empty `ScanReport` with `overrides` applied, for driving `reportScanIncidents`. */
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
    unresolvedDeclarations: [],
    treeReleaseFailures: [],
    fellBackToSingleComponent: false,
    exitCode: EXIT.SUCCESS,
    ...overrides,
  }
}

/** Every line `reportScanIncidents` writes for `report`, in order. */
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
  /**
   * Responses keyed by the first two args (`"rev-parse --verify"`), overriding the defaults
   * below. Each receives the whole argument list.
   */
  handlers?: Record<string, (args: readonly string[]) => GitOutput | Promise<GitOutput>>
  /**
   * Materialises the base checkout when `worktree add` is issued, at the path git was given.
   * Throws when the path is missing rather than resolving `undefined` against `process.cwd()`.
   */
  onWorktreeAdd?: (worktreeDir: string) => Promise<void> | void
  /**
   * What a command with no handler does. `"succeed"` (the default) answers empty output;
   * `"throw"` rejects, so a git call `runDiff` grows is covered by nothing rather than by
   * a fake that cannot fail.
   */
  unmodelled?: "succeed" | "throw"
}

/**
 * A `git` far enough for `runDiff`'s ref mode: the commands `resolveViaGit` issues, and the two
 * more it asks when a ref does not resolve, are modelled with the answers of a healthy,
 * non-shallow repository with commits, and every call is recorded.
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
