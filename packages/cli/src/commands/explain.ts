import { dirname, join, relative, resolve, sep } from "node:path"
import { backslashSite, symbolIdFile } from "@aburi/core"
import { type ProjectSymbolExplainContext, projectSymbolExplain } from "@aburi/markdown-projection"
import type { IR, Symbol as IRSymbol, SkippedFile, UnresolvedCallDiagnostic } from "@aburi/types"
import { IR_JSON_FILENAME, resolveOutputDir } from "../artifact-paths"
import { configuredOutputDir, pinConfig } from "../config-load"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { pathExists } from "../fs-probe"
import { readIR } from "../ir-io"
import { writeOutputFile } from "../output-file"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"
import { runScan } from "./scan"

/** What this command's one artefact is called when a write of it fails. */
const MARKDOWN_ARTEFACT = "the explain Markdown"

export interface ExplainOptions {
  cwd?: string
  configPath?: string
  argument: string
  irPath?: string
  outputPath?: string
  noRescan?: boolean
  debugResolution?: boolean
  warn?: WarnFn
}

export type ExplainOutcome =
  | {
      kind: "single"
      markdown: string
      symbol: IRSymbol
      exitCode: ExitCode
      writtenTo: string | null
    }
  | {
      kind: "file"
      markdown: string
      symbols: readonly IRSymbol[]
      exitCode: ExitCode
      writtenTo: string | null
    }
  | { kind: "ambiguous"; candidates: readonly IRSymbol[]; exitCode: ExitCode }
  | { kind: "not-found"; exitCode: ExitCode; coverage: CoverageDoubt | null }
  | { kind: "unnameable"; path: string; unnameablePrefix: string; exitCode: ExitCode }
  | {
      kind: "unknown"
      exitCode: typeof EXIT.GATE
      skipped: SkippedFile
      /** Whether the file came from the argument itself or from the file segment of an id. */
      namedBy: "id" | "path"
    }

export type CoverageDoubt =
  | { kind: "named-losses"; files: readonly [SkippedFile, ...SkippedFile[]] }
  /** The document predates `stats.skippedFiles`: it counts its losses but cannot name them. */
  | { kind: "unnamed-losses"; fileCount: number }

export async function runExplain(options: ExplainOptions): Promise<ExplainOutcome> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)
  assertDebugResolutionCombination(options)
  const resolved = await readOrScanIR(cwd, workspaceRoot, options)
  const outcome = withScanFault(
    await locate(resolved, cwd, workspaceRoot, options),
    resolved.scanFaulted,
  )
  if ("writtenTo" in outcome && outcome.writtenTo !== null) {
    await writeOutputFile(
      { command: "explain", artefact: MARKDOWN_ARTEFACT, path: outcome.writtenTo },
      outcome.markdown,
    )
  }
  return outcome
}

function withScanFault(outcome: ExplainOutcome, scanFaulted: boolean): ExplainOutcome {
  if (!scanFaulted) return outcome
  return { ...outcome, exitCode: EXIT.GATE }
}

async function locate(
  resolved: ResolvedIR,
  cwd: string,
  workspaceRoot: string,
  options: ExplainOptions,
): Promise<ExplainOutcome> {
  const ir = resolved.ir
  const explainContext: ProjectSymbolExplainContext = {
    dependencies: ir.dependencies,
    ...(resolved.unresolvedCalls === null ? {} : { unresolvedCalls: resolved.unresolvedCalls }),
  }

  const arg = options.argument
  const outputPath = options.outputPath === undefined ? null : resolve(cwd, options.outputPath)
  const skippedByPath = new Map<string, SkippedFile>()
  for (const file of ir.stats.skippedFiles ?? []) skippedByPath.set(file.path, file)
  const coverage = coverageDoubt(ir)

  if (arg.includes("#")) {
    const hit = ir.symbols.find((s) => s.id === arg)
    if (hit !== undefined) {
      const markdown = projectSymbolExplain(hit, explainContext)
      return {
        kind: "single",
        markdown,
        symbol: hit,
        exitCode: EXIT.SUCCESS,
        writtenTo: outputPath,
      }
    }
    const claimed = symbolIdFile(arg)
    if (claimed !== null) return missed(skippedByPath.get(claimed), "id", coverage)
  }

  if (arg.includes("/")) {
    const nativeRelative = relative(workspaceRoot, resolve(cwd, arg))
    const documentPath = (
      sep === "/" ? nativeRelative : nativeRelative.split(sep).join("/")
    ).normalize("NFC")
    const unnameable = backslashSite(documentPath)
    if (unnameable !== null) {
      return {
        kind: "unnameable",
        path: documentPath,
        unnameablePrefix: unnameable.prefix,
        exitCode: EXIT.GATE,
      }
    }
    const skipped = skippedByPath.get(documentPath)
    if (skipped !== undefined || (await pathExists(resolve(cwd, arg)))) {
      const inFile = ir.symbols.filter((s) => s.source.file === documentPath)
      if (inFile.length === 0) return missed(skipped, "path", coverage)
      const markdown = inFile.map((s) => projectSymbolExplain(s, explainContext)).join("\n---\n\n")
      return {
        kind: "file",
        markdown,
        symbols: inFile,
        exitCode: EXIT.SUCCESS,
        writtenTo: outputPath,
      }
    }
  }

  const matches = ir.symbols.filter((s) => s.name.includes(arg))
  if (matches.length === 0) return { kind: "not-found", exitCode: EXIT.RUNTIME, coverage }
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches, exitCode: EXIT.INPUT_ERROR }
  }
  const only = matches[0]
  if (only === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME, coverage }
  const markdown = projectSymbolExplain(only, explainContext)
  return {
    kind: "single",
    markdown,
    symbol: only,
    exitCode: EXIT.SUCCESS,
    writtenTo: outputPath,
  }
}

function missed(
  skipped: SkippedFile | undefined,
  namedBy: "id" | "path",
  coverage: CoverageDoubt | null,
): ExplainOutcome {
  if (skipped === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME, coverage }
  return { kind: "unknown", exitCode: EXIT.GATE, skipped, namedBy }
}

function coverageDoubt(ir: IR): CoverageDoubt | null {
  const skippedFiles = ir.stats.skippedFiles
  if (skippedFiles !== undefined) {
    const [first, ...rest] = skippedFiles
    if (first === undefined) return null
    return { kind: "named-losses", files: [first, ...rest] }
  }
  const unnamed = ir.stats.totalFiles - ir.stats.parsedFiles
  if (unnamed <= 0) return null
  return { kind: "unnamed-losses", fileCount: unnamed }
}

function assertDebugResolutionCombination(options: ExplainOptions): void {
  if (options.debugResolution !== true) return
  if (options.noRescan) {
    throw new CliError(
      "--debug-resolution needs a fresh scan (call-resolution.md keeps the per-call buckets out of the IR), so it cannot be combined with --no-rescan.",
      "input-error",
    )
  }
  if (options.irPath !== undefined) {
    throw new CliError(
      "--debug-resolution needs a fresh scan (call-resolution.md keeps the per-call buckets out of the IR), so it cannot read an existing --ir file.",
      "input-error",
    )
  }
}

interface ResolvedIR {
  ir: IR
  unresolvedCalls: readonly UnresolvedCallDiagnostic[] | null
  scanFaulted: boolean
}

async function readOrScanIR(
  cwd: string,
  workspaceRoot: string,
  options: ExplainOptions,
): Promise<ResolvedIR> {
  const wantsDiagnostics = options.debugResolution === true

  if (!wantsDiagnostics) {
    const explicit = options.irPath === undefined ? null : resolve(cwd, options.irPath)
    if (explicit !== null) {
      return { ir: await readIR(explicit), unresolvedCalls: null, scanFaulted: false }
    }

    const outputDir = await configuredOutputDir(await pinConfig(cwd, options.configPath))
    const candidates = irSearchPath(cwd, workspaceRoot, outputDir)
    const [nearest] = candidates
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        if (candidate !== nearest) {
          options.warn?.(`Answering from ${candidate}; there is no IR under ${resolve(cwd)}.`)
        }
        return { ir: await readIR(candidate), unresolvedCalls: null, scanFaulted: false }
      }
    }

    if (options.noRescan) {
      const rest =
        candidates.length > 1 ? `, nor in any directory up to ${resolve(workspaceRoot)}` : ""
      throw new CliError(
        `No IR file at ${nearest}${rest}, and --no-rescan was set. Run \`aburi scan\` first or pass --ir <path>.`,
        "input-error",
      )
    }
  }

  const scanOptions: Parameters<typeof runScan>[0] = {
    cwd,
    command: "explain",
    format: "json",
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.warn === undefined ? {} : { incidents: { warn: options.warn } }),
  }
  const report = await runScan(scanOptions)
  if (report.irPath === null) {
    throw new CliError("Scan produced no IR file for aburi explain.", "runtime-error")
  }
  return {
    ir: await readIR(report.irPath),
    unresolvedCalls: wantsDiagnostics ? report.unresolvedCalls : null,
    scanFaulted: report.exitCode !== EXIT.SUCCESS,
  }
}

function irSearchPath(
  cwd: string,
  workspaceRoot: string,
  outputDir: string | undefined,
): readonly [string, ...string[]] {
  const first = join(resolveOutputDir(cwd, undefined, outputDir), IR_JSON_FILENAME)
  const paths: [string, ...string[]] = [first]
  const root = resolve(workspaceRoot)
  let directory = resolve(cwd)
  while (directory !== root) {
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
    const candidate = join(resolveOutputDir(directory, undefined, outputDir), IR_JSON_FILENAME)
    if (!paths.includes(candidate)) paths.push(candidate)
  }
  return paths
}
