import { resolve } from "node:path"
import {
  describeThrown,
  isComponentId,
  isPluginSetFault,
  isStrict,
  type ScanResult,
  scan,
  serializeCanonical,
  type UndeclaredVocabOccurrence,
} from "@aburi/core"
import {
  componentHeading,
  formatCallResolutionLine,
  projectComponent,
  projectWorkspace,
} from "@aburi/markdown-projection"
import type {
  CallResolutionStats,
  ComponentId,
  Config,
  FrameworkPlugin,
  IR,
  Logger,
  ParseError,
} from "@aburi/types"
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
  listOutputFiles,
  type OutputArtefact,
  type OutputCommand,
  removeOutputFile,
  removeOutputFileOpeningWith,
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
import {
  declaredComponents,
  pluginNamedFrameworks,
  resolveComponents,
  resolveManagers,
} from "./scan-components"
import { findCoverageFault } from "./scan-coverage"
import { reportScanIncidents } from "./scan-incidents"
import type { ScanReport, StrayPluginOptions } from "./scan-report"

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
    /**
     * The pluginOptions lines an earlier scan of the same command already said. Share one set only
     * across scans that read one config and load one plugin set.
     */
    said?: Set<string>
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

  const managers = await resolveManagers(config, workspaceRoot)
  const components = await resolveComponents(config, workspaceRoot, plugins.languages)
  const fellBackToSingleComponent =
    declaredComponents(config) === undefined && managers.workspaces.length === 0

  const command = options.command ?? "scan"
  const outputDir = resolveOutputDir(cwd, options.outputDir, config.output?.dir)
  await createOutputDir(command, outputDir)
  const logger = createLogger(options.logLevel === undefined ? {} : { minimum: options.logLevel })
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
      logger,
    })
  } catch (error) {
    if (isPluginSetFault(error)) {
      throw new CliError(describeThrown(error), "plugin-error", { cause: error })
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

  const loadedPlugins = plugins.registry.listPlugins().map((plugin) => plugin.name)
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
    lspWarnings: [...scanResult.lspWarnings],
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
    unnameableRoots: managers.unnameableRoots,
    fellBackToSingleComponent,
    pluginNamedFrameworks: pluginNamedFrameworks(config, plugins.registry),
    loadedPlugins,
    strayPluginOptions: strayPluginOptions(config, loadedPlugins, loaded.syntheticPlugins),
    exitCode:
      scanResult.extractionFailures.length > 0 ||
      coverageFault !== null ||
      scanResult.unrepresentableFiles.length > 0 ||
      managers.unnameableRoots.length > 0
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
        logger,
      )
      if (format === "md") await removeUnwritten(logger, irOutput(command, outputDir))
      if (format === "json") await removeUnwritten(logger, workspaceMdOutput(command, outputDir))
      await removeComponentMdsExcept(command, outputDir, report.componentMdPaths, logger)
    }
  } catch (error) {
    try {
      reportIncidents(report, options.incidents)
    } catch (sinkError) {
      // A throw from here would replace the error that ended the scan.
      logger.warn(`Failed to report the scan's incidents: ${errorMessage(sinkError)}`)
    }
    throw error
  }
  reportIncidents(report, options.incidents)
  return report
}

function reportIncidents(report: ScanReport, incidents: ScanOptions["incidents"]): void {
  if (incidents === undefined) return
  reportScanIncidents(report, incidents.warn, incidents.label ?? null, incidents.said)
}

function describeParseErrors(errors: readonly ParseError[]): string {
  const first = errors[0]
  if (first === undefined) return "parse errors reported without detail"
  const where = `${first.line}:${first.column} — ${first.message}`
  return errors.length === 1 ? where : `${errors.length} errors, first at ${where}`
}

function strayPluginOptions(
  config: Config,
  loadedPlugins: readonly string[],
  hintPlugins: readonly FrameworkPlugin[],
): StrayPluginOptions[] {
  // A hint plugin provides one framework, the id its frameworkHints entry is named by.
  const hintEntries = new Map(
    hintPlugins.flatMap(({ manifest }) =>
      manifest.provides.frameworks.map((entry) => [manifest.name, entry] as const),
    ),
  )
  return Object.keys(config.pluginOptions ?? {}).flatMap((key): StrayPluginOptions[] => {
    const hintEntry = hintEntries.get(key)
    if (hintEntry !== undefined) return [{ key, hintEntry }]
    return loadedPlugins.includes(key) ? [] : [{ key, hintEntry: null }]
  })
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

function irOutput(command: OutputCommand, outputDir: string): OutputArtefact {
  return { command, artefact: "the IR", path: resolve(outputDir, IR_JSON_FILENAME) }
}

function workspaceMdOutput(command: OutputCommand, outputDir: string): OutputArtefact {
  return {
    command,
    artefact: "the workspace Markdown",
    path: resolve(outputDir, WORKSPACE_MD_FILENAME),
  }
}

function componentMdOutput(
  command: OutputCommand,
  outputDir: string,
  id: ComponentId,
): OutputArtefact {
  return {
    command,
    artefact: `the Markdown for component "${id}"`,
    path: resolve(outputDir, COMPONENTS_DIRNAME, `${id}.md`),
  }
}

async function writeIR(
  command: OutputCommand,
  outputDir: string,
  ir: IR,
  options: ScanOptions,
): Promise<string> {
  const output = irOutput(command, outputDir)
  let serialized: string
  try {
    serialized = serializeCanonical(ir, { format: options.compact ? "compact" : "pretty" })
  } catch (error) {
    throw new CliError(
      `Failed to serialize the IR for ${output.path}: ${errorMessage(error)}`,
      "config-error",
      { cause: error },
    )
  }
  await writeOutputFile(output, serialized)
  return output.path
}

async function writeWorkspaceMd(
  command: OutputCommand,
  outputDir: string,
  ir: IR,
  options: ScanOptions,
): Promise<string> {
  const output = workspaceMdOutput(command, outputDir)
  const md = renderPage(output.artefact, () =>
    projectWorkspace(ir, { suppressTimestamp: options.suppressTimestamp ?? false }),
  )
  await writeOutputFile(output, md)
  return output.path
}

async function writeComponentMds(
  command: OutputCommand,
  outputDir: string,
  ir: IR,
): Promise<string[]> {
  const written: string[] = []
  for (const component of ir.components) {
    const output = componentMdOutput(command, outputDir, component.id)
    const md = renderPage(output.artefact, () =>
      projectComponent({
        component,
        symbols: ir.symbols.filter((symbol) => symbol.component === component.id),
        dependencies: ir.dependencies,
      }),
    )
    await writeOutputFile(output, md)
    written.push(output.path)
  }
  return written
}

async function removeComponentMdsExcept(
  command: OutputCommand,
  outputDir: string,
  written: readonly string[],
  logger: Logger,
): Promise<void> {
  const kept = new Set(written)
  const directory = {
    command,
    artefact: "the components directory",
    path: resolve(outputDir, COMPONENTS_DIRNAME),
  }
  for (const name of await listOutputFiles(directory)) {
    const id = name.endsWith(".md") ? name.slice(0, -".md".length) : ""
    if (!isComponentId(id)) continue
    const page = componentMdOutput(command, outputDir, id)
    if (!kept.has(page.path)) await removeUnwritten(logger, page, componentHeading(id))
  }
}

async function removeUnwritten(
  logger: Logger,
  output: OutputArtefact,
  firstLine?: string,
): Promise<void> {
  const removed =
    firstLine === undefined
      ? await removeOutputFile(output)
      : await removeOutputFileOpeningWith(output, firstLine)
  if (removed) logger.info(`Removed ${output.artefact} at ${output.path}`)
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
  logger: Logger,
): Promise<string | null> {
  const record = {
    command: "scan" as const,
    artefact: "the discovered-vocabulary record",
    path: resolve(outputDir, VOCAB_DISCOVERED_FILENAME),
  }
  if (contents === null) {
    await removeUnwritten(logger, record)
    return null
  }
  await writeOutputFile(record, contents)
  return record.path
}

function discoveredAt(options: ScanOptions): string | null {
  return options.suppressTimestamp === true ? null : new Date().toISOString()
}
