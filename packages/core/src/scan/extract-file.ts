import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type {
  Component,
  Config,
  EffectPlugin,
  FrameworkPlugin,
  LanguagePlugin,
  SourceFile,
  VocabRegistry,
} from "@aburi/types"
import { CoreError } from "../errors"
import { buildComponentAttribution } from "./attribute"
import type { DiscoveredFile } from "./discover"
import { buildDropCFilter } from "./drop-c"
import { type ExtractionEvent, eventLogger } from "./extraction-events"
import { describeThrown, errorCode, isPluginSetFault, isVanishedFile } from "./faults"
import { ImportOrigins } from "./import-origins"
import { type FilePipelineResult, runFilePipeline, type TreeReleaseFailure } from "./pipeline"
import { buildLanguageRouter } from "./route"
import { isStrict, type UndeclaredVocabOccurrence, VocabCheck } from "./vocab"

/** What extracting any file of a scan reads beside the plugins: plain data, so a thread can hold it. */
export interface ExtractionJob {
  readonly workspaceRoot: string
  /** A file is named by its index here. */
  readonly files: readonly DiscoveredFile[]
  readonly config: Config
  readonly components: readonly Component[]
}

export interface ExtractionPlugins {
  readonly languages: readonly LanguagePlugin[]
  readonly frameworks: readonly FrameworkPlugin[]
  readonly effects: readonly EffectPlugin[]
  readonly registry: VocabRegistry
}

export type FileOutcome =
  | { readonly kind: "unroutable" }
  | { readonly kind: "vanished"; readonly detail: string }
  | { readonly kind: "threw"; readonly message: string; readonly code?: string }
  /** Ends the run: a fault of the plugin set, or a file that could not be read. */
  | { readonly kind: "fatal"; readonly error: unknown }
  /** The thread extracting the file ended under it, which only a parse pool reports. */
  | { readonly kind: "crashed"; readonly detail: string }
  | {
      readonly kind: "ran"
      readonly result: FilePipelineResult
      readonly content: string
      readonly undeclaredVocab: readonly UndeclaredVocabOccurrence[]
    }

export interface FileExtraction {
  readonly fileId: number
  readonly outcome: FileOutcome
  readonly events: readonly ExtractionEvent[]
}

export interface FileExtractor {
  /** Calls that overlap run one after another, in the order they were made. */
  extract(fileId: number): Promise<FileExtraction>
}

// One extractor serves every file it is given, so the barrels it parses for one importer are
// parsed once for all of them.
export function createFileExtractor(job: ExtractionJob, plugins: ExtractionPlugins): FileExtractor {
  const router = buildLanguageRouter(plugins.languages)
  const attribute = buildComponentAttribution(job.components)
  const dropCFilter = buildDropCFilter({
    pluginDropCallees: plugins.effects.flatMap((effect) => effect.dropCallees ?? []),
    ...(job.config.suppress === undefined ? {} : { suppress: job.config.suppress }),
    ...(job.config.keep === undefined ? {} : { keep: job.config.keep }),
  })
  const strictVocab = isStrict(job.config)

  let events: ExtractionEvent[] = []
  const record = (event: ExtractionEvent): void => {
    events.push(event)
  }
  const log = eventLogger((level, message, meta) =>
    record({ kind: "log", level, message, ...(meta === undefined ? {} : { meta }) }),
  )
  const origins = new ImportOrigins({
    workspaceRoot: job.workspaceRoot,
    files: job.files,
    router,
    loadSource: (file) => loadSourceFile(job.workspaceRoot, file),
    record,
  })

  const outcomeOf = async (file: DiscoveredFile): Promise<FileOutcome> => {
    const language = router.route(file.path)
    if (language === null) return { kind: "unroutable" }

    let sourceFile: SourceFile
    try {
      sourceFile = await loadSourceFile(job.workspaceRoot, file)
    } catch (error) {
      if (!isVanishedFile(error)) return { kind: "fatal", error }
      return { kind: "vanished", detail: describeThrown(error) }
    }

    const released: TreeReleaseFailure[] = []
    const vocab = new VocabCheck(plugins.registry, strictVocab)
    try {
      const result = await runFilePipeline({
        file: sourceFile,
        language,
        frameworks: plugins.frameworks,
        effects: plugins.effects,
        registry: plugins.registry,
        config: job.config,
        dropCFilter,
        component: attribute(sourceFile.path),
        log,
        treeReleaseFailures: released,
        vocab,
        origins,
      })
      if (result.kind !== "parse-timeout") origins.remember(result.path, result.imports)
      return {
        kind: "ran",
        result,
        content: sourceFile.content,
        undeclaredVocab: vocab.occurrences,
      }
    } catch (error) {
      if (isPluginSetFault(error)) return { kind: "fatal", error }
      const code = errorCode(error)
      return { kind: "threw", message: describeThrown(error), ...(code === null ? {} : { code }) }
    } finally {
      for (const failure of released) record({ kind: "tree-release-failure", failure })
    }
  }

  const run = async (fileId: number): Promise<FileExtraction> => {
    const file = job.files[fileId]
    if (file === undefined) throw unknownFile(fileId, job.files.length)
    events = []
    const outcome = await outcomeOf(file)
    return { fileId, outcome, events }
  }

  let last: Promise<unknown> = Promise.resolve()
  return {
    extract(fileId) {
      const extraction = last.then(() => run(fileId))
      last = extraction.catch(() => {})
      return extraction
    },
  }
}

export async function loadSourceFile(
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

function unknownFile(fileId: number, count: number): CoreError {
  return new CoreError(
    `Internal error: asked to extract file ${fileId} of a scan that discovered ${count}\n` +
      "This is a bug in Aburi — please report it at https://github.com/kage1020/Aburi/issues.",
    { code: "scan-file-unknown" },
  )
}
