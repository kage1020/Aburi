import { access, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { detectWorkspaceRoot } from "@aburi/core"
import { projectSymbolExplain } from "@aburi/markdown-projection"
import type { IR, Symbol as IRSymbol } from "@aburi/types"
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
  const ir = await resolveIR(cwd, workspaceRoot, options)

  const arg = options.argument
  const outputPath = options.outputPath === undefined ? null : resolve(cwd, options.outputPath)

  if (arg.includes("#")) {
    const hit = ir.symbols.find((s) => s.id === arg)
    if (hit === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME }
    const markdown = projectSymbolExplain(hit)
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
    const markdown = inFile.map((s) => projectSymbolExplain(s)).join("\n---\n\n")
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
  const markdown = projectSymbolExplain(only)
  if (outputPath !== null) await writeFile(outputPath, markdown, "utf8")
  return {
    kind: "single",
    markdown,
    symbol: only,
    exitCode: EXIT.SUCCESS,
    writtenTo: outputPath,
  }
}

async function resolveIR(cwd: string, workspaceRoot: string, options: ExplainOptions): Promise<IR> {
  const explicit = options.irPath === undefined ? null : resolve(cwd, options.irPath)
  if (explicit !== null) return readIR(explicit)

  const defaultPath = resolve(workspaceRoot, "out/aburi.ir.json")
  if (await pathExistsStrict(defaultPath)) return readIR(defaultPath)

  if (options.noRescan) {
    throw new CliError(
      `No IR file at ${defaultPath} and --no-rescan was set. Run \`aburi scan\` first or pass --ir <path>.`,
      "input-error",
    )
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
  return readIR(report.irPath)
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
