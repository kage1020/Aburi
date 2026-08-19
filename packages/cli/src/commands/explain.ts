import { access, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { detectWorkspaceRoot, symbolIdFile } from "@aburi/core"
import { type ProjectSymbolExplainContext, projectSymbolExplain } from "@aburi/markdown-projection"
import type { IR, Symbol as IRSymbol, SkippedFile, UnresolvedCallDiagnostic } from "@aburi/types"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { readIR } from "../ir-io"
import type { WarnFn } from "../warn"
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
  /**
   * Sink for the incidents of the scan this command runs when no IR is on disk (§5.6).
   * Reading an existing IR runs no scan and reports nothing — the live signal fired when
   * `aburi scan` wrote the file.
   */
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
  /**
   * The question named a file, and the document says that file was never analysed. Not an
   * absence: the answer is that this IR cannot have one.
   */
  | {
      kind: "unknown"
      /**
       * Always the gate. An answer the document cannot give must not be reportable as one of
       * the codes that says it did, and the type is where that is cheapest to enforce.
       */
      exitCode: typeof EXIT.GATE
      skipped: SkippedFile
      /** Whether the file came from the argument itself or from the file segment of an id. */
      namedBy: "id" | "path"
    }

/**
 * What an IR says about its own coverage, attached to a lookup that found nothing.
 *
 * Attached to every miss, in every arm, that the document could not tie to a file. The id and
 * file arms do name one, but naming it is not enough: the answer is `unknown` only when that
 * path is in the skip list, and a miss on a file the document did analyse carries this doubt
 * like any other. A hit carries nothing — the document is speaking about a Symbol it holds, and
 * an `over-size` file is skipped by every run of a workspace, so a caveat on hits would be a
 * permanent one.
 */
export type CoverageDoubt =
  /**
   * `stats.skippedFiles` names the files, and one of them may hold the answer. The entries
   * rather than a count, so the number cannot drift from the list it describes; non-empty,
   * so "no doubt" cannot be spelled as a doubt over zero files. What to print out of them is
   * the CLI wrapper's decision, not this type's.
   */
  | { kind: "named-losses"; files: readonly [SkippedFile, ...SkippedFile[]] }
  /** The document predates `stats.skippedFiles`: it counts its losses but cannot name them. */
  | { kind: "unnamed-losses"; fileCount: number }

/**
 * `aburi explain <id-or-pattern>` — three-arm dispatch mirrored from
 * `docs/design/cli-spec.md §7.2`:
 *
 * - argument contains `#` → full Symbol id lookup.
 * - argument contains `/` but no `#` AND either resolves to an existing file or is named in
 *   `stats.skippedFiles` → all Symbols whose `source.file` matches (compared against the
 *   workspace-root-relative POSIX path so a run from a subdirectory still hits the right
 *   rows). The second leg is what `--ir` / `--no-rescan` are for: a pinned artifact is read
 *   in a tree that need not hold the file, and requiring it on disk would drop the question
 *   into the substring arm.
 * - otherwise → case-sensitive substring match on `Symbol.name`.
 *
 * When the substring match hits more than one Symbol the caller receives an
 * `ambiguous` outcome (exit 2) so they can add more of the qualified name. Zero hits
 * become `not-found` (exit 1), or `unknown` (exit 3) when the question named a file the
 * document says it never analysed — §7.6. Both codes are overridden by `withScanFault` when
 * the scan this command ran did not exit clean, because the answer is then unsafe whichever
 * of the three it was. Every "single" / "file" outcome carries the resolved
 * `writtenTo` path when `--output` was supplied so the CLI wrapper can suppress the
 * stdout mirror (avoiding the "output to file *and* stdout" behaviour the design
 * intentionally rules out).
 */
export async function runExplain(options: ExplainOptions): Promise<ExplainOutcome> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)
  assertDebugResolutionCombination(options)
  const resolved = await resolveIR(cwd, workspaceRoot, options)
  return withScanFault(await locate(resolved, cwd, workspaceRoot, options), resolved.scanFaulted)
}

/**
 * A scan that did not exit clean outranks whatever the lookup concluded.
 *
 * Every outcome is suspect in that state, including the successful ones: a file the scan
 * withdrew is absent from the IR, so a `single` answer may have had a competing candidate that
 * would have made it `ambiguous`, and a `not-found` may be describing the withdrawal rather
 * than the workspace. Reporting `0` for the first and `1` for the second would let a broken
 * toolchain look like a clean answer, which is the state §5.6 already refuses to call green for
 * `aburi scan`; the command asking the question does not change that.
 *
 * The condition is the scan's own exit code rather than a named incident, so a second reason to
 * gate — `runScan` says outright that there may be one — arrives here without an edit.
 */
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
  const lost = new Map<string, SkippedFile>()
  for (const file of ir.stats.skippedFiles ?? []) lost.set(file.path, file)
  const coverage = coverageDoubt(ir)

  if (arg.includes("#")) {
    const hit = ir.symbols.find((s) => s.id === arg)
    if (hit === undefined) {
      const claimed = symbolIdFile(arg)
      return missed(claimed === null ? undefined : lost.get(claimed), "id", coverage)
    }
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

  if (arg.includes("/")) {
    // Normalised into the space the document is in: `stats.skippedFiles[].path` and
    // `symbols[].source.file` are NFC by schema and by invariant #19, while the argument is
    // whatever the shell handed over — and a name carrying a combining mark survives an
    // archive or a rename in decomposed form. Both lookups below key on this string.
    // Not `toPosixRelative`: it throws on `..` and on absolute paths, and an argument
    // shaped like either has to fall through to the substring arm rather than error.
    const relPath = relative(workspaceRoot, resolve(cwd, arg)).replace(/\\/g, "/").normalize("NFC")
    // The skip list is consulted before the disk probe, not after: a file the document
    // already describes needs no filesystem to answer for it, and `unreadable` is a reason
    // whose file may well refuse the probe too.
    const skipped = lost.get(relPath)
    if (skipped !== undefined || (await pathExistsStrict(resolve(cwd, arg)))) {
      const inFile = ir.symbols.filter((s) => s.source.file === relPath)
      if (inFile.length === 0) return missed(skipped, "path", coverage)
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
  }

  const matches = ir.symbols.filter((s) => s.name.includes(arg))
  if (matches.length === 0) return { kind: "not-found", exitCode: EXIT.RUNTIME, coverage }
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches, exitCode: EXIT.INPUT_ERROR }
  }
  const only = matches[0]
  if (only === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME, coverage }
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
 * A lookup that found nothing, answered as precisely as the document allows.
 *
 * The split is between a doubt the document can attach to the question and one it can only
 * state about the run. The id and file arms name a file, so `stats.skippedFiles` either holds
 * it — in which case the document positively contradicts "not found", and the honest answer
 * is that it has none — or it does not, and the miss stands as one, qualified by whatever
 * else the run lost.
 *
 * Called on a miss only. A Symbol that is present is answered from the document, however its
 * id reads: the id's file segment is where the Symbol was declared to live when the id was
 * minted, and `source.file` is where the document says it is, so consulting the skip list
 * first would let a re-exported or generated Symbol be reported as unanswerable while it sits
 * in `symbols[]`.
 */
function missed(
  skipped: SkippedFile | undefined,
  namedBy: "id" | "path",
  coverage: CoverageDoubt | null,
): ExplainOutcome {
  if (skipped === undefined) return { kind: "not-found", exitCode: EXIT.RUNTIME, coverage }
  return { kind: "unknown", exitCode: EXIT.GATE, skipped, namedBy }
}

/**
 * What the document knows about its own gaps, read straight out of `stats`.
 *
 * A present-but-empty `skippedFiles` is no doubt at all: the key is Class B and writers omit
 * it when nothing was lost, but a document that spells the empty case out is still saying the
 * scan covered everything. Absent, the arithmetic is the only trace left — `aburi diff` warns
 * about the same shape per side — and it can be counted but not named.
 *
 * The zero guard covers a scan that lost nothing, not a document that contradicts itself:
 * invariant #21 holds `parsedFiles` to no more than `totalFiles` whether or not the list is
 * present, so a subtraction that came back negative was refused by `readIR` before reaching
 * here.
 */
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
  /**
   * Whether the scan behind `ir` reported a fault of its own. `false` when the IR came off
   * disk: that document is whatever the scan that wrote it produced, and its incidents were
   * reported then.
   */
  scanFaulted: boolean
}

async function resolveIR(
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

    const defaultPath = resolve(workspaceRoot, "out/aburi.ir.json")
    if (await pathExistsStrict(defaultPath)) {
      return { ir: await readIR(defaultPath), unresolvedCalls: null, scanFaulted: false }
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
