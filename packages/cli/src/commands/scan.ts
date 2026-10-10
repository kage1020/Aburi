import { resolve } from "node:path"
import {
  CoreError,
  detectManagers,
  isStrict,
  type ScanResult,
  scan,
  serializeCanonical,
  type UndeclaredVocabOccurrence,
} from "@aburi/core"
import {
  formatCallResolutionLine,
  projectComponent,
  projectWorkspace,
} from "@aburi/markdown-projection"
import type { CallResolutionStats, Config, IR, ParseError } from "@aburi/types"
import {
  COMPONENTS_DIRNAME,
  IR_JSON_FILENAME,
  resolveOutputDir,
  WORKSPACE_MD_FILENAME,
} from "../artifact-paths"
import { loadPinnedConfig, type PinnedConfig, pinConfig } from "../config-load"
import type { LogLevel } from "../env"
import { CliError, errorMessage, internalFault } from "../errors"
import { EXIT } from "../exit-codes"
import { readGeneratorInfo } from "../generator-info"
import { createLogger } from "../logger"
import {
  createOutputDir,
  type OutputCommand,
  removeOutputFile,
  writeOutputFile,
} from "../output-file"
import { loadPlugins } from "../plugin-loader"
import {
  renderVocabDiscovered,
  summarizeUndeclaredVocab,
  VOCAB_DISCOVERED_FILENAME,
} from "../vocab-discovered"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"
import { declaredComponents, pluginNamedFrameworks, resolveComponents } from "./scan-components"
import { findCoverageFault } from "./scan-coverage"
import { reportScanIncidents } from "./scan-incidents"
import type { ScanReport } from "./scan-report"

export interface ScanOptions {
  cwd?: string
  command?: OutputCommand
  configPath?: string
  pinnedConfig?: PinnedConfig
  pluginRefRoot?: string
  outputDir?: string
  format?: "json" | "md" | "both"
  ignore?: readonly string[]
  respectGitignore?: boolean
  compact?: boolean
  suppressTimestamp?: boolean
  strict?: boolean
  lsp?: boolean
  logLevel?: LogLevel
  incidents?: {
    warn: WarnFn
    label?: string
  }
}

export async function runScan(options: ScanOptions = {}): Promise<ScanReport> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)

  const pinnedConfig = options.pinnedConfig ?? (await pinConfig(cwd, options.configPath))
  const loaded = await loadPinnedConfig(pinnedConfig)
  const config = mergeCliOverrides(loaded.config, options)

  const plugins = await loadPlugins({
    config,
    workspaceRoot,
    pluginRefRoot: options.pluginRefRoot ?? workspaceRoot,
    syntheticPlugins: loaded.syntheticPlugins,
  })
  requireLanguagePlugin(plugins.languages.length, loaded.source)

  const managers = await detectManagers(workspaceRoot)
  const components = await resolveComponents(config, workspaceRoot, plugins.languages)
  const fellBackToSingleComponent =
    declaredComponents(config) === undefined && managers.workspaces.length === 0

  const command = options.command ?? "scan"
  const outputDir = resolveOutputDir(cwd, options.outputDir, config.output?.dir)
  await createOutputDir(command, outputDir)
  let scanResult: ScanResult
  try {
    scanResult = await scan({
      workspaceRoot,
      config,
      languages: plugins.languages,
      frameworks: plugins.frameworks,
      effects: plugins.effects,
      registry: plugins.registry,
      workspaceManagers: managers.managers.map((manager) => ({
        tool: manager.tool,
        roots: [...manager.roots],
      })),
      components,
      generator: await readGeneratorInfo(),
      logger: createLogger(options.logLevel === undefined ? {} : { minimum: options.logLevel }),
    })
  } catch (error) {
    if (error instanceof CoreError && error.code === "vocab-undeclared") {
      throw new CliError(error.message, "plugin-error", { cause: error })
    }
    throw error
  }

  const format = options.format ?? "both"
  const irPath = format === "md" ? null : await writeIR(command, outputDir, scanResult.ir, options)
  const undeclaredVocab = summarizeUndeclaredVocab(requireUndeclaredVocab(scanResult))
  const withdrawnByParse = new Set(
    scanResult.skipped.filter((file) => file.reason === "parse-failed").map((file) => file.path),
  )
  const parseErrorFiles = scanResult.parseErrors
    .filter((record) => !withdrawnByParse.has(record.file))
    .map((record) => ({ path: record.file, detail: describeParseErrors(record.errors) }))
  const coverageFault = findCoverageFault(
    scanResult.ir.stats.totalFiles,
    scanResult.ir.stats.parsedFiles,
    scanResult.skipped,
    config.minParsedFileRatio,
  )

  const report: ScanReport = {
    irPath,
    workspaceMdPath: null,
    componentMdPaths: [],
    totalFiles: scanResult.ir.stats.totalFiles,
    parsedFiles: scanResult.ir.stats.parsedFiles,
    keptSymbols: scanResult.ir.stats.keptSymbols,
    droppedSymbols: scanResult.ir.stats.droppedSymbols,
    parseErrorFiles,
    parseErrorCount: parseErrorFiles.length,
    parseFailureCount: withdrawnByParse.size,
    timeoutCount: scanResult.timeoutEvents.length,
    skipped: scanResult.skipped.map(({ path, reason, detail }) =>
      detail === undefined ? { path, reason } : { path, reason, detail },
    ),
    extractionFailures: scanResult.extractionFailures.map((failure) => ({ ...failure })),
    treeReleaseFailures: scanResult.treeReleaseFailures.map((failure) => ({ ...failure })),
    lspEnrichment: scanResult.ir.stats.lspEnrichment,
    callResolutionLine: formatCallResolutionLine(requireCallResolution(scanResult.ir)),
    unresolvedCalls: scanResult.unresolvedCalls,
    configSource: loaded.source,
    configPinnedByCaller: options.pinnedConfig !== undefined,
    workspaceRoot,
    coverageFault,
    unrepresentableFiles: scanResult.unrepresentableFiles.map((file) => ({ ...file })),
    undeclaredVocab,
    vocabDiscoveredPath: null,
    unresolvedDeclarations: managers.unresolved,
    fellBackToSingleComponent,
    pluginNamedFrameworks: pluginNamedFrameworks(config, plugins.registry),
    exitCode:
      scanResult.extractionFailures.length > 0 ||
      coverageFault !== null ||
      scanResult.unrepresentableFiles.length > 0
        ? EXIT.GATE
        : EXIT.SUCCESS,
  }
  try {
    if (format !== "json") {
      report.workspaceMdPath = await writeWorkspaceMd(command, outputDir, scanResult.ir, options)
      report.componentMdPaths = await writeComponentMds(command, outputDir, scanResult.ir)
    }
    if (command === "scan") {
      report.vocabDiscoveredPath = await updateVocabRecord(
        outputDir,
        isStrict(config) ? null : renderVocabDiscovered(undeclaredVocab, discoveredAt(options)),
      )
    }
  } catch (error) {
    reportIncidents(report, options.incidents)
    throw error
  }
  reportIncidents(report, options.incidents)
  return report
}

function reportIncidents(report: ScanReport, incidents: ScanOptions["incidents"]): void {
  if (incidents === undefined) return
  try {
    reportScanIncidents(report, incidents.warn, incidents.label ?? null)
  } catch {}
}

function describeParseErrors(errors: readonly ParseError[]): string {
  const first = errors[0]
  if (first === undefined) return "parse errors reported without detail"
  const where = `${first.line}:${first.column} — ${first.message}`
  return errors.length === 1 ? where : `${errors.length} errors, first at ${where}`
}

function requireUndeclaredVocab(result: ScanResult): readonly UndeclaredVocabOccurrence[] {
  const occurrences: readonly UndeclaredVocabOccurrence[] | undefined = result.undeclaredVocab
  if (occurrences === undefined) {
    throw new CliError(
      "scan() returned no undeclaredVocab; @aburi/core is older than this @aburi/cli and does not report the vocabulary a scan with strict off kept.",
      "runtime-error",
    )
  }
  return occurrences
}

function requireCallResolution(ir: IR): CallResolutionStats {
  const stats = ir.stats.callResolution
  if (stats === undefined) {
    throw new CliError(
      "scan() returned an IR without stats.callResolution; @aburi/core stopped emitting the call-resolution census.",
      "runtime-error",
    )
  }
  return stats
}

function requireLanguagePlugin(count: number, configSource: string | null): void {
  if (count > 0) return
  const where = configSource === null ? "no aburi.json was found" : `config: ${configSource}`
  throw new CliError(
    `No language plugin is configured (${where}), so no source file can be parsed. Add one ` +
      `to "languages" in aburi.json — e.g. "lang-typescript" — or run \`aburi init\`.`,
    "config-error",
  )
}

function mergeCliOverrides(config: Partial<Config>, options: ScanOptions): Config {
  const merged: Partial<Config> = { ...config }
  if (options.ignore !== undefined && options.ignore.length > 0) {
    merged.ignore = [...(merged.ignore ?? []), ...options.ignore]
  }
  if (options.respectGitignore !== undefined) merged.respectGitignore = options.respectGitignore
  if (options.strict !== undefined) merged.strict = options.strict
  if (options.lsp !== undefined) {
    merged.lsp = { ...(merged.lsp ?? {}), enabled: options.lsp }
  }
  return merged as Config
}

async function writeIR(
  command: OutputCommand,
  outputDir: string,
  ir: IR,
  options: ScanOptions,
): Promise<string> {
  const path = resolve(outputDir, IR_JSON_FILENAME)
  let serialized: string
  try {
    serialized = serializeCanonical(ir, { format: options.compact ? "compact" : "pretty" })
  } catch (error) {
    throw new CliError(
      `Failed to serialize the IR for ${path}: ${errorMessage(error)}`,
      "config-error",
      { cause: error },
    )
  }
  await writeOutputFile({ command, artefact: "the IR", path }, serialized)
  return path
}

async function writeWorkspaceMd(
  command: OutputCommand,
  outputDir: string,
  ir: IR,
  options: ScanOptions,
): Promise<string> {
  const path = resolve(outputDir, WORKSPACE_MD_FILENAME)
  const artefact = "the workspace Markdown"
  const md = renderPage(artefact, () =>
    projectWorkspace(ir, { suppressTimestamp: options.suppressTimestamp ?? false }),
  )
  await writeOutputFile({ command, artefact, path }, md)
  return path
}

async function writeComponentMds(
  command: OutputCommand,
  outputDir: string,
  ir: IR,
): Promise<string[]> {
  const written: string[] = []
  for (const component of ir.components) {
    const artefact = `the Markdown for component "${component.id}"`
    const md = renderPage(artefact, () =>
      projectComponent({
        component,
        symbols: ir.symbols.filter((symbol) => symbol.component === component.id),
        dependencies: ir.dependencies,
      }),
    )
    const path = resolve(outputDir, COMPONENTS_DIRNAME, `${component.id}.md`)
    await writeOutputFile({ command, artefact, path }, md)
    written.push(path)
  }
  return written
}

function renderPage(artefact: string, render: () => string): string {
  try {
    return render()
  } catch (error) {
    throw internalFault(` while rendering ${artefact}`, errorMessage(error), error)
  }
}

async function updateVocabRecord(
  outputDir: string,
  contents: string | null,
): Promise<string | null> {
  const record = {
    command: "scan" as const,
    artefact: "the discovered-vocabulary record",
    path: resolve(outputDir, VOCAB_DISCOVERED_FILENAME),
  }
  if (contents === null) {
    await removeOutputFile(record)
    return null
  }
  await writeOutputFile(record, contents)
  return record.path
}

function discoveredAt(options: ScanOptions): string | null {
  return options.suppressTimestamp === true ? null : new Date().toISOString()
}
