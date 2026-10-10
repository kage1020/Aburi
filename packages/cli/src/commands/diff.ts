import { resolve } from "node:path"
import { buildDiff, DiffError, type GitRenameMap, writeCanonicalDiff } from "@aburi/diff"
import {
  formatCallResolutionLine,
  projectDiff,
  projectDiffSummaryLine,
} from "@aburi/markdown-projection"
import type { IR, IRRef } from "@aburi/types"
import {
  DIFF_FULL_MD_FILENAME,
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  resolveOutputDir,
} from "../artifact-paths"
import { configuredOutputDir, type PinnedConfig, pinConfig } from "../config-load"
import { CliError, errorMessage, internalFault, unplacedErrorCode } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { evaluateFailOn, type FailOnClause, formatTriggered, parseFailOn } from "../fail-on"
import { readGeneratorInfo } from "../generator-info"
import type { GitRunner } from "../git/runner"
import { readIR } from "../ir-io"
import { createOutputDir, removeOutputFile, writeOutputFile } from "../output-file"
import type { WarnFn } from "../warn"
import { chooseInputs, type DiffInputs } from "./diff-inputs"
import {
  type DiffSide,
  type RevisionScanContext,
  type ScanPair,
  scanRevisions,
} from "./diff-revisions"
import { faultedSides, warnAboutComparison } from "./diff-warnings"

export function classifyDiffError(error: DiffError): CliError {
  switch (error.code) {
    case "schema-mismatch":
    case "invalid-line-fuzz":
    case "ir-shape-invalid":
    case "ir-identity-collision":
      return new CliError(error.message, "config-error", { cause: error })
    case "slice-invariant-violated":
      return internalFault("", error.message, error)
    default:
      return unplacedErrorCode("", "diff", error, error.code)
  }
}

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
  maxBytes?: number
  git?: GitRunner
  warn?: WarnFn
}

export interface DiffReport {
  diffJsonPath: string | null
  diffMdPath: string | null
  diffFullMdPath: string | null
  summaryLine: string
  callResolutionLine: string | null
  triggered: { clause: FailOnClause; observed: number } | null
  faultedScans: readonly DiffSide[] | null
  exitCode: ExitCode
}

export async function runDiff(options: DiffOptions): Promise<DiffReport> {
  const cwd = options.cwd ?? process.cwd()
  const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`))
  const failOn = options.failOn === undefined ? [] : parseFailOn(options.failOn)
  if (
    options.maxBytes !== undefined &&
    (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0)
  ) {
    throw new CliError(
      `--max-bytes must be a positive integer (got ${String(options.maxBytes)}).`,
      "input-error",
    )
  }
  let pinned: PinnedConfig | null = null
  const pinConfigOnce = async (): Promise<PinnedConfig> => {
    pinned ??= await pinConfig(cwd, options.configPath)
    return pinned
  }
  const inputs = chooseInputs(options)
  const outputDir = resolveOutputDir(
    cwd,
    options.outputDir,
    options.outputDir === undefined ? await configuredOutputDir(await pinConfigOnce()) : undefined,
  )
  await createOutputDir("diff", outputDir)
  await removeEarlierReport(outputDir)
  const compared = await readSides(inputs, {
    cwd,
    git: options.git,
    compact: options.compact,
    pinConfigOnce,
    warn,
  })

  const generator = await readGeneratorInfo()
  let diff: BuiltDiff
  try {
    diff = buildDiff({
      baseIR: compared.baseIR,
      headIR: compared.headIR,
      base: irRef(compared.baseRef, compared.baseIR),
      head: irRef(compared.headRef, compared.headIR),
      generator,
      ...(compared.gitRenames === null ? {} : { gitRenames: compared.gitRenames }),
    })
  } catch (error) {
    if (error instanceof DiffError) throw classifyDiffError(error)
    throw error
  }

  const written = await writeReport(diff, outputDir, options, warn)
  const { firstTriggered } = evaluateFailOn(failOn, diff)
  const faultedScans = faultedSides(compared.scans)
  const exitCode: ExitCode =
    firstTriggered === null && (faultedScans === null || faultedScans.length === 0)
      ? EXIT.SUCCESS
      : EXIT.GATE

  warnAboutComparison({ ...compared, notCompared: diff.notCompared }, warn)
  const callResolution = compared.headIR.stats.callResolution
  return {
    ...written,
    summaryLine: projectDiffSummaryLine(diff),
    callResolutionLine:
      callResolution === undefined ? null : formatCallResolutionLine(callResolution),
    triggered: firstTriggered,
    faultedScans,
    exitCode,
  }
}

export function formatFailOnMessage(triggered: NonNullable<DiffReport["triggered"]>): string {
  return formatTriggered(triggered.clause, triggered.observed)
}

async function removeEarlierReport(outputDir: string): Promise<void> {
  for (const [artefact, filename] of [
    ["the diff JSON", DIFF_JSON_FILENAME],
    ["the diff Markdown", DIFF_MD_FILENAME],
    ["the uncapped diff Markdown", DIFF_FULL_MD_FILENAME],
  ] as const) {
    await removeOutputFile({ command: "diff", artefact, path: resolve(outputDir, filename) })
  }
}

type BuiltDiff = ReturnType<typeof buildDiff>

interface ComparedSides {
  baseIR: IR
  headIR: IR
  baseRef: string
  headRef: string
  gitRenames: GitRenameMap | null
  scans: ScanPair | null
}

async function readSides(inputs: DiffInputs, context: RevisionScanContext): Promise<ComparedSides> {
  if (inputs.kind === "refs") {
    const scanned = await scanRevisions(inputs.spec, context)
    return { ...scanned, baseRef: inputs.spec.base, headRef: inputs.spec.head }
  }
  return {
    baseIR: await readIR(resolve(context.cwd, inputs.base)),
    headIR: await readIR(resolve(context.cwd, inputs.head)),
    baseRef: inputs.base,
    headRef: inputs.head,
    gitRenames: null,
    scans: null,
  }
}

type WrittenReport = Pick<DiffReport, "diffJsonPath" | "diffMdPath" | "diffFullMdPath">

async function writeReport(
  diff: BuiltDiff,
  outputDir: string,
  options: Pick<DiffOptions, "format" | "compact" | "maxBytes">,
  warn: WarnFn,
): Promise<WrittenReport> {
  const format = options.format ?? "both"
  const written: WrittenReport = { diffJsonPath: null, diffMdPath: null, diffFullMdPath: null }
  if (format !== "md") {
    const diffJsonPath = resolve(outputDir, DIFF_JSON_FILENAME)
    let serialized: string
    try {
      serialized = writeCanonicalDiff(diff, { format: options.compact ? "compact" : "pretty" })
    } catch (error) {
      throw new CliError(
        `Failed to serialize the diff for ${diffJsonPath}: ${errorMessage(error)}`,
        "config-error",
        { cause: error },
      )
    }
    await writeOutputFile(
      { command: "diff", artefact: "the diff JSON", path: diffJsonPath },
      serialized,
    )
    written.diffJsonPath = diffJsonPath
  }
  if (format === "json") {
    if (options.maxBytes !== undefined) {
      warn(
        `⚠ --max-bytes has no effect under --format json: the cap applies to ${DIFF_MD_FILENAME}, which this run does not write.`,
      )
    }
    return written
  }
  const diffMdPath = resolve(outputDir, DIFF_MD_FILENAME)
  const uncapped = projectDiff(diff)
  let markdown = uncapped
  if (options.maxBytes !== undefined && Buffer.byteLength(uncapped, "utf8") > options.maxBytes) {
    const fullMdPath = resolve(outputDir, DIFF_FULL_MD_FILENAME)
    await writeOutputFile(
      { command: "diff", artefact: "the uncapped diff Markdown", path: fullMdPath },
      uncapped,
    )
    written.diffFullMdPath = fullMdPath
    markdown = projectDiff(diff, {
      maxBytes: options.maxBytes,
      fullReportLocation: `\`${DIFF_FULL_MD_FILENAME}\` beside \`${DIFF_MD_FILENAME}\``,
    })
    const bytes = Buffer.byteLength(markdown, "utf8")
    if (bytes > options.maxBytes) {
      warn(
        `⚠ ${DIFF_MD_FILENAME} is ${bytes} bytes, over the ${options.maxBytes} requested: every section was dropped and the title and summary alone exceed it. Raise --max-bytes.`,
      )
    }
  }
  await writeOutputFile(
    { command: "diff", artefact: "the diff Markdown", path: diffMdPath },
    markdown,
  )
  written.diffMdPath = diffMdPath
  return written
}

function irRef(refName: string, ir: IR): IRRef {
  return { ref: refName, irSchema: ir.$schema }
}
