import { access, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { projectSymbolExplain } from "@aburi/markdown-projection"
import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
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
  | { kind: "single"; markdown: string; symbol: IRSymbol; exitCode: ExitCode }
  | { kind: "file"; markdown: string; symbols: readonly IRSymbol[]; exitCode: ExitCode }
  | {
      kind: "ambiguous"
      candidates: readonly IRSymbol[]
      exitCode: ExitCode
    }
  | { kind: "not-found"; exitCode: ExitCode }

/**
 * §7 — `aburi explain <id-or-pattern>`. Three-arm dispatch mirrored from §7.2:
 * - contains `#` → full Symbol id lookup
 * - contains `/` but no `#` AND exists on disk → file-scoped lookup (all Symbols in file)
 * - otherwise → case-sensitive substring match on `Symbol.name`
 *
 * When the substring match hits more than one Symbol, returns an `ambiguous` outcome so
 * the CLI wrapper can list candidates on stdout and exit 2. When it hits none, returns
 * `not-found` (exit 1 per §7.6).
 */
export async function runExplain(options: ExplainOptions): Promise<ExplainOutcome> {
  const cwd = options.cwd ?? process.cwd()
  const ir = await resolveIR(cwd, options)

  const arg = options.argument
  if (arg.includes("#")) {
    const hit = ir.symbols.find((s) => s.id === arg)
    if (hit === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME }
    return {
      kind: "single",
      markdown: projectSymbolExplain(hit),
      symbol: hit,
      exitCode: EXIT.SUCCESS,
    }
  }

  if (arg.includes("/") && (await pathExists(resolve(cwd, arg)))) {
    const relative = relativeToWorkspace(arg, cwd)
    const inFile = ir.symbols.filter((s) => s.source.file === relative)
    if (inFile.length === 0) {
      return { kind: "not-found", exitCode: EXIT.RUNTIME }
    }
    const markdown = inFile.map((s) => projectSymbolExplain(s)).join("\n---\n\n")
    const written = options.outputPath === undefined ? null : resolve(cwd, options.outputPath)
    if (written !== null) await writeFile(written, markdown, "utf8")
    return { kind: "file", markdown, symbols: inFile, exitCode: EXIT.SUCCESS }
  }

  const matches = ir.symbols.filter((s) => s.name.includes(arg))
  if (matches.length === 0) {
    return { kind: "not-found", exitCode: EXIT.RUNTIME }
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches, exitCode: EXIT.INPUT_ERROR }
  }
  const only = matches[0]
  if (only === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME }
  const markdown = projectSymbolExplain(only)
  const written = options.outputPath === undefined ? null : resolve(cwd, options.outputPath)
  if (written !== null) await writeFile(written, markdown, "utf8")
  return { kind: "single", markdown, symbol: only, exitCode: EXIT.SUCCESS }
}

async function resolveIR(cwd: string, options: ExplainOptions): Promise<IR> {
  const explicit = options.irPath === undefined ? null : resolve(cwd, options.irPath)
  if (explicit !== null) return readIR(explicit)

  const defaultPath = resolve(cwd, "out/aburi.ir.json")
  if (await pathExists(defaultPath)) return readIR(defaultPath)

  if (options.noRescan) {
    throw new CliError(
      `No IR file at ${defaultPath} and --no-rescan was set. Run \`aburi scan\` first or pass --ir <path>.`,
      "input-error",
    )
  }

  // §7.4 fallback: silently run scan to produce an IR
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function relativeToWorkspace(arg: string, cwd: string): string {
  const absolute = resolve(cwd, arg)
  const relative = absolute.slice(cwd.length + 1).replace(/\\/g, "/")
  return relative
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
