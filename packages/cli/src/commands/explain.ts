import { access, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { detectWorkspaceRoot } from "@aburi/core"
import { type ProjectSymbolExplainContext, projectSymbolExplain } from "@aburi/markdown-projection"
import type { IR, Symbol as IRSymbol, UnresolvedCallDiagnostic } from "@aburi/types"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { readIR } from "../ir-io"
import { runScan } from "./scan"

export interface ExplainOptions {
  cwd?: string
  configPath?: string
  argument: string
  irPath?: string
  outputPath?: string
  noRescan?: boolean
  /**
   * Append the per-call `## Call resolution` table of `call-resolution.md`
   * §8.1. The buckets are per-run diagnostics that the IR deliberately does not
   * persist, so this always rescans the workspace — an on-disk IR simply cannot
   * answer the question.
   */
  debugResolution?: boolean
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
  | { kind: "not-found"; exitCode: ExitCode }

/**
 * `aburi explain <id-or-pattern>` — three-arm dispatch mirrored from
 * `docs/design/cli-spec.md §7.2`:
 *
 * - argument contains `#` → full Symbol id lookup.
 * - argument contains `/` but no `#` AND resolves to an existing file → all Symbols
 *   whose `source.file` matches (compared against the workspace-root-relative POSIX
 *   path so a run from a subdirectory still hits the right rows).
 * - otherwise → case-sensitive substring match on `Symbol.name`.
 *
 * When the substring match hits more than one Symbol the caller receives an
 * `ambiguous` outcome (exit 2) so they can add more of the qualified name. Zero hits
 * become `not-found` (exit 1). Every "single" / "file" outcome carries the resolved
 * `writtenTo` path when `--output` was supplied so the CLI wrapper can suppress the
 * stdout mirror (avoiding the "output to file *and* stdout" behaviour the design
 * intentionally rules out).
 */
export async function runExplain(options: ExplainOptions): Promise<ExplainOutcome> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)
  assertDebugResolutionCombination(options)
  const resolved = await resolveIR(cwd, workspaceRoot, options)
  const ir = resolved.ir
  const explainContext: ProjectSymbolExplainContext = {
    dependencies: ir.dependencies,
    ...(resolved.unresolvedCalls === null ? {} : { unresolvedCalls: resolved.unresolvedCalls }),
  }

  const arg = options.argument
  const outputPath = options.outputPath === undefined ? null : resolve(cwd, options.outputPath)

  if (arg.includes("#")) {
    const hit = ir.symbols.find((s) => s.id === arg)
    if (hit === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME }
    const markdown = projectSymbolExplain(hit, explainContext)
    if (outputPath !== null) await writeFile(outputPath, markdown, "utf8")
    return {
      kind: "single",
      markdown,
      symbol: hit,
      exitCode: EXIT.SUCCESS,
      writtenTo: outputPath,
    }
  }

  if (arg.includes("/") && (await pathExistsStrict(resolve(cwd, arg)))) {
    const relPath = relative(workspaceRoot, resolve(cwd, arg)).replace(/\\/g, "/")
    const inFile = ir.symbols.filter((s) => s.source.file === relPath)
    if (inFile.length === 0) return { kind: "not-found", exitCode: EXIT.RUNTIME }
    const markdown = inFile.map((s) => projectSymbolExplain(s, explainContext)).join("\n---\n\n")
    if (outputPath !== null) await writeFile(outputPath, markdown, "utf8")
    return {
      kind: "file",
      markdown,
      symbols: inFile,
      exitCode: EXIT.SUCCESS,
      writtenTo: outputPath,
    }
  }

  const matches = ir.symbols.filter((s) => s.name.includes(arg))
  if (matches.length === 0) return { kind: "not-found", exitCode: EXIT.RUNTIME }
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches, exitCode: EXIT.INPUT_ERROR }
  }
  const only = matches[0]
  if (only === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME }
  const markdown = projectSymbolExplain(only, explainContext)
  if (outputPath !== null) await writeFile(outputPath, markdown, "utf8")
  return {
    kind: "single",
    markdown,
    symbol: only,
    exitCode: EXIT.SUCCESS,
    writtenTo: outputPath,
  }
}

/**
 * `--debug-resolution` needs diagnostics that only a live scan produces, so the
 * two flags that pin `explain` to an existing artifact are incompatible with it.
 * Failing loudly beats silently rescanning a workspace the user asked us not to
 * touch, or emitting an empty table that reads like "nothing unresolved".
 */
function assertDebugResolutionCombination(options: ExplainOptions): void {
  if (options.debugResolution !== true) return
  if (options.noRescan) {
    throw new CliError(
      "--debug-resolution needs a fresh scan (call-resolution.md §8.1 keeps the per-call buckets out of the IR), so it cannot be combined with --no-rescan.",
      "input-error",
    )
  }
  if (options.irPath !== undefined) {
    throw new CliError(
      "--debug-resolution needs a fresh scan (call-resolution.md §8.1 keeps the per-call buckets out of the IR), so it cannot read an existing --ir file.",
      "input-error",
    )
  }
}

interface ResolvedIR {
  ir: IR
  /**
   * Diagnostics from the scan that produced `ir`, or `null` when the IR was
   * read from disk (the file cannot carry them) or `--debug-resolution` was not
   * requested.
   */
  unresolvedCalls: readonly UnresolvedCallDiagnostic[] | null
}

async function resolveIR(
  cwd: string,
  workspaceRoot: string,
  options: ExplainOptions,
): Promise<ResolvedIR> {
  const wantsDiagnostics = options.debugResolution === true

  if (!wantsDiagnostics) {
    const explicit = options.irPath === undefined ? null : resolve(cwd, options.irPath)
    if (explicit !== null) return { ir: await readIR(explicit), unresolvedCalls: null }

    const defaultPath = resolve(workspaceRoot, "out/aburi.ir.json")
    if (await pathExistsStrict(defaultPath)) {
      return { ir: await readIR(defaultPath), unresolvedCalls: null }
    }

    if (options.noRescan) {
      throw new CliError(
        `No IR file at ${defaultPath} and --no-rescan was set. Run \`aburi scan\` first or pass --ir <path>.`,
        "input-error",
      )
    }
  }

  const scanOptions: Parameters<typeof runScan>[0] = {
    cwd,
    format: "json",
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  }
  const report = await runScan(scanOptions)
  if (report.irPath === null) {
    throw new CliError("Scan produced no IR file for aburi explain.", "runtime-error")
  }
  return {
    ir: await readIR(report.irPath),
    unresolvedCalls: wantsDiagnostics ? report.unresolvedCalls : null,
  }
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  try {
    return await detectWorkspaceRoot({ cwd })
  } catch {
    return resolve(cwd)
  }
}

/**
 * `access` treats every errno as "not usable", but "does not exist" and "permission
 * denied" mean very different things to the caller: the first is a fall-through, the
 * second is a configuration mistake we must surface. This wrapper only treats
 * ENOENT / ENOTDIR as absence; anything else is re-thrown as a `CliError` so an EACCES
 * cannot silently bypass the "config exists" check upstream in `init`.
 */
async function pathExistsStrict(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isBenignErrno(error)) return false
    throw new CliError(`Failed to probe ${path}: ${errorMessage(error)}`, "runtime-error", {
      cause: error,
    })
  }
}

const BENIGN_ERRNOS = new Set(["ENOENT", "ENOTDIR"])

function isBenignErrno(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && BENIGN_ERRNOS.has(code)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
