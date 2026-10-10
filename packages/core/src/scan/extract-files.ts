import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type {
  Component,
  Config,
  EffectPlugin,
  FrameworkPlugin,
  ImportEdge,
  Symbol as IRSymbol,
  Logger,
  ParseError,
  SourceFile,
  VocabRegistry,
} from "@aburi/types"
import { countBy } from "../collections"
import { CoreError } from "../errors"
import { symbolIdFile } from "../id"
import type { ReadFile } from "../lsp"
import { buildComponentAttribution } from "./attribute"
import type { DiscoveredFile, SkippedFile } from "./discover"
import { buildDropCFilter } from "./drop-c"
import { describeThrown, errorCode, isVanishedFile } from "./faults"
import { runFilePipeline, type TreeReleaseFailure } from "./pipeline"
import type { LanguageRouter } from "./route"
import type { ClassifyTimeoutEvent, ParseTimeoutEvent } from "./timeout"
import { isStrict, type UndeclaredVocabOccurrence, VocabCheck } from "./vocab"

export interface ExtractionFailure {
  file: string
  message: string
  code?: string
}

export interface ParseErrorRecord {
  file: string
  errors: readonly ParseError[]
}

export interface ExtractFilesInput {
  workspaceRoot: string
  files: readonly DiscoveredFile[]
  router: LanguageRouter
  config: Config
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  components: readonly Component[]
  logger: Logger
}

export interface ExtractedFiles {
  symbols: IRSymbol[]
  skipped: SkippedFile[]
  parseErrors: ParseErrorRecord[]
  timeoutEvents: ClassifyTimeoutEvent[]
  parseTimeouts: ParseTimeoutEvent[]
  extractionFailures: ExtractionFailure[]
  treeReleaseFailures: TreeReleaseFailure[]
  undeclaredVocab: UndeclaredVocabOccurrence[]
  importsByFile: Map<string, readonly ImportEdge[]>
  fileContents: Map<string, ReadFile>
  dynamicCallSites: Set<string>
}

export async function extractFiles(input: ExtractFilesInput): Promise<ExtractedFiles> {
  const { logger, router } = input
  const attribute = buildComponentAttribution(input.components)

  const dropCFilterInput: Parameters<typeof buildDropCFilter>[0] = {
    pluginDropCallees: input.effects.flatMap((e) => e.dropCallees ?? []),
  }
  if (input.config.suppress !== undefined) dropCFilterInput.suppress = input.config.suppress
  if (input.config.keep !== undefined) dropCFilterInput.keep = input.config.keep
  const dropCFilter = buildDropCFilter(dropCFilterInput)

  const out: ExtractedFiles = {
    symbols: [],
    skipped: [],
    parseErrors: [],
    timeoutEvents: [],
    parseTimeouts: [],
    extractionFailures: [],
    treeReleaseFailures: [],
    undeclaredVocab: [],
    importsByFile: new Map(),
    fileContents: new Map(),
    dynamicCallSites: new Set(),
  }
  const strictVocab = isStrict(input.config)
  const warnedReleaseFailure = new Set<string>()
  for (const discoveredFile of input.files) {
    const language = router.route(discoveredFile.path)
    if (language === null) {
      out.skipped.push({
        path: discoveredFile.path,
        reason: "unroutable",
        detail: "extension survived discovery filter but no plugin claims it",
      })
      continue
    }

    let sourceFile: SourceFile
    try {
      sourceFile = await loadSourceFile(input.workspaceRoot, discoveredFile)
    } catch (error) {
      if (!isVanishedFile(error)) throw error
      const detail = describeThrown(error)
      out.skipped.push({ path: discoveredFile.path, reason: "unreadable", detail })
      logger.warn(
        `Skipped ${discoveredFile.path}: it was no longer a file by the time it was read — ${detail}`,
      )
      continue
    }

    let result: Awaited<ReturnType<typeof runFilePipeline>>
    const releasesRecordedBefore = out.treeReleaseFailures.length
    const fileVocab = new VocabCheck(input.registry, strictVocab)
    try {
      result = await runFilePipeline({
        file: sourceFile,
        language,
        frameworks: input.frameworks,
        effects: input.effects,
        registry: input.registry,
        config: input.config,
        dropCFilter,
        component: attribute(sourceFile.path),
        log: logger,
        treeReleaseFailures: out.treeReleaseFailures,
        vocab: fileVocab,
      })
    } catch (error) {
      if (isPluginSetFault(error)) throw error
      const message = describeThrown(error)
      out.skipped.push({
        path: discoveredFile.path,
        reason: "extraction-failed",
        detail: message,
      })
      const code = errorCode(error)
      out.extractionFailures.push({
        file: discoveredFile.path,
        message,
        ...(code === null ? {} : { code }),
      })
      logger.warn(`Skipped ${discoveredFile.path}: extraction threw — ${message}`)
      continue
    } finally {
      for (const failure of out.treeReleaseFailures.slice(releasesRecordedBefore)) {
        if (warnedReleaseFailure.has(failure.plugin)) continue
        warnedReleaseFailure.add(failure.plugin)
        logger.warn(
          `Plugin ${failure.plugin} did not release the parse tree for ${failure.file}: ${failure.detail}. ` +
            "A tree the plugin does not free is not reclaimed by the garbage collector, so a long " +
            "enough run exhausts the parser's heap.",
        )
      }
    }

    if (result.parseErrors.length > 0) {
      out.parseErrors.push({ file: discoveredFile.path, errors: result.parseErrors })
    }

    switch (result.kind) {
      case "parse-timeout": {
        const spent = Math.round(result.timeout.elapsedMs)
        const budget = result.timeout.budgetMs
        out.parseTimeouts.push(result.timeout)
        out.skipped.push({
          path: discoveredFile.path,
          reason: result.kind,
          detail: `extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms)`,
        })
        logger.warn(
          `Skipped ${discoveredFile.path}: extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms). Override with config.parseTimeoutMs.`,
        )
        break
      }
      case "parse-failed": {
        const detail = describeParseFailure(result.parseErrors)
        out.skipped.push({ path: discoveredFile.path, reason: result.kind, detail })
        logger.warn(`Skipped ${discoveredFile.path}: ${detail}`)
        out.importsByFile.set(result.path, result.imports)
        break
      }
      case "extracted": {
        const collision = describeIdFault(result.symbols, discoveredFile.path)
        if (collision !== null) {
          out.skipped.push({
            path: discoveredFile.path,
            reason: "extraction-failed",
            detail: collision,
          })
          out.extractionFailures.push({
            file: discoveredFile.path,
            message: collision,
            code: "duplicate-symbol-id",
          })
          logger.warn(`Skipped ${discoveredFile.path}: ${collision}`)
          out.timeoutEvents.push(...result.timeoutEvents)
          out.importsByFile.set(discoveredFile.path, result.imports)
          break
        }

        out.undeclaredVocab.push(...fileVocab.occurrences)

        out.fileContents.set(sourceFile.path, {
          content: sourceFile.content,
          fsPath: discoveredFile.fsPath,
        })

        out.timeoutEvents.push(...result.timeoutEvents)
        out.symbols.push(...result.symbols)
        out.importsByFile.set(result.path, result.imports)
        for (const key of result.dynamicCallSites) out.dynamicCallSites.add(key)
        break
      }
      default:
        throw unhandledOutcome(result)
    }
  }

  for (const [plugin, count] of countBy(out.treeReleaseFailures, (failure) => failure.plugin)) {
    if (count > 1) {
      logger.warn(`Plugin ${plugin} failed to release ${count} parse trees over this run.`)
    }
  }

  return out
}

function describeParseFailure(errors: readonly ParseError[]): string {
  const fatal = errors.find((error) => error.recoverable === false)
  if (fatal !== undefined) return `parse reported a non-recoverable error at ${quote(fatal)}`
  const first = errors[0]
  if (first === undefined) return "the language plugin returned no tree"
  return `the language plugin returned no tree; first error at ${quote(first)}`
}

function quote(error: ParseError): string {
  return `${error.line}:${error.column} — ${error.message}`
}

function describeIdFault(symbols: readonly IRSymbol[], path: string): string | null {
  const here = new Map<string, IRSymbol>()
  for (const symbol of symbols) {
    const claimed = symbolIdFile(symbol.id)
    if (claimed !== null && claimed !== path) {
      return (
        `Symbol id "${symbol.id}" names ${claimed}, which is not this file. An id carries the ` +
        `file its Symbol was declared in, so the language plugin wrote a path that is not ` +
        `this file's`
      )
    }
    const twin = here.get(symbol.id)
    if (twin !== undefined) {
      return (
        `two Symbols share the id "${symbol.id}" (lines ${twin.source.startLine} and ` +
        `${symbol.source.startLine}); the language plugin gave two declarations one qualified ` +
        `name, and nothing it reported separates them`
      )
    }
    here.set(symbol.id, symbol)
  }
  return null
}

const PLUGIN_SET_FAULT_CODES: ReadonlySet<string> = new Set([
  "scan-plugin-misconfigured",
  "invalid-language-id",
  "vocab-undeclared",
])

function isPluginSetFault(error: unknown): boolean {
  const code = errorCode(error)
  return code !== null && PLUGIN_SET_FAULT_CODES.has(code)
}

async function loadSourceFile(
  workspaceRoot: string,
  discovered: DiscoveredFile,
): Promise<SourceFile> {
  const absolute = resolve(workspaceRoot, discovered.fsPath)
  const content = await readFile(absolute, "utf8")
  return { path: discovered.path, content: normalizeLineTerminators(content) }
}

export function normalizeLineTerminators(content: string): string {
  return content.includes("\r") ? content.replace(/\r\n?/g, "\n") : content
}

function unhandledOutcome(outcome: never): CoreError {
  return new CoreError(
    `Internal error: the scan does not handle the file outcome ${describeThrown(outcome)}\n` +
      "This is a bug in Aburi — please report it at https://github.com/kage1020/Aburi/issues.",
    { code: "scan-outcome-unhandled" },
  )
}
