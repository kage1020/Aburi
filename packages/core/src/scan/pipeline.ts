import type {
  BodyExtraction,
  ComponentId,
  Config,
  EffectPlugin,
  ExtractionContext,
  FrameworkClassifyContext,
  FrameworkPlugin,
  ImportEdge,
  Symbol as IRSymbol,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParsedTree,
  ParseError,
  SourceFile,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { buildDroppedSymbol, buildKeptSymbol, extractLanguageFromId } from "./build-symbol"
import { type ClassifyCallsInput, classifyCalls } from "./classify-calls"
import { decideDropReason, mergeFrameworkClassification } from "./classify-symbol"
import type { DropCFilter } from "./drop-c"
import { describeJsonType, describeThrown } from "./faults"
import { normalizeCandidateStrings, normalizeImportEdge } from "./normalize"
import { type ClassifyTimeoutEvent, type ParseTimeoutEvent, startParseDeadline } from "./timeout"
import type { VocabCheck } from "./vocab"

interface FileOutcomeCommon {
  path: string
  parseErrors: readonly ParseError[]
}

export interface ExtractedFile extends FileOutcomeCommon {
  kind: "extracted"
  symbols: IRSymbol[]
  imports: readonly ImportEdge[]
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  dynamicCallSites: readonly string[]
}

export interface ParseFailedFile extends FileOutcomeCommon {
  kind: "parse-failed"
  imports: readonly ImportEdge[]
}

export interface ParseTimeoutFile extends FileOutcomeCommon {
  kind: "parse-timeout"
  timeout: ParseTimeoutEvent
}

export type FilePipelineResult = ExtractedFile | ParseFailedFile | ParseTimeoutFile

export interface FilePipelineInput {
  file: SourceFile
  language: LanguagePlugin
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  config: Config
  dropCFilter: DropCFilter
  component: ComponentId | null
  log: Logger
  treeReleaseFailures: TreeReleaseFailure[]
  vocab: VocabCheck
}

export interface TreeReleaseFailure {
  plugin: string
  file: string
  detail: string
}

export async function runFilePipeline(input: FilePipelineInput): Promise<FilePipelineResult> {
  const {
    file,
    language,
    frameworks,
    effects,
    registry,
    config,
    dropCFilter,
    component,
    log,
    vocab,
  } = input

  const deadline = startParseDeadline(config.parseTimeoutMs)
  const abandonedFile = (): ParseTimeoutFile => ({
    kind: "parse-timeout",
    path: file.path,
    parseErrors,
    timeout: {
      file: file.path,
      budgetMs: deadline.budgetMs,
      elapsedMs: deadline.elapsedMs(),
    },
  })

  const parseResult = await language.parseFile(file)
  const parseErrors = parseResult.errors
  const timeoutEvents: ClassifyTimeoutEvent[] = []

  try {
    const imports = parseResult.imports.map(normalizeImportEdge)

    if (parseResult.tree === null || parseErrors.some((error) => error.recoverable === false)) {
      return { kind: "parse-failed", path: file.path, parseErrors, imports }
    }

    if (deadline.expired()) return abandonedFile()

    const extractCtx: ExtractionContext = { file, registry, config }
    const candidates = language.extractSymbols(parseResult.tree, extractCtx)
    if (deadline.expired()) return abandonedFile()

    const symbols: IRSymbol[] = []
    const dynamicCallSites: string[] = []

    const frameworkCtx: FrameworkClassifyContext = { ...extractCtx, imports }

    for (const raw of candidates) {
      if (deadline.expired()) return abandonedFile()

      const { candidate, confidence, extKindBy } = mergeFrameworkClassification(
        normalizeCandidateStrings(raw),
        frameworks,
        frameworkCtx,
        language.manifest.name,
      )
      if (candidate.extKind !== null && extKindBy !== null) {
        vocab.extKind({
          value: candidate.extKind,
          plugin: extKindBy,
          file: file.path,
          line: null,
          symbol: candidate.id,
        })
      }
      const dropReason = decideDropReason(candidate, language, frameworks, frameworkCtx)

      if (dropReason !== null) {
        symbols.push(
          buildDroppedSymbol(
            candidate,
            dropReason,
            extractLanguageFromId(candidate.id),
            component,
            confidence,
          ),
        )
        continue
      }

      const walkCtx: WalkContext<OpaqueAstNode> = { ...extractCtx, symbol: candidate }
      const body: BodyExtraction = language.walkBody(candidate, walkCtx)

      const classifyCallsInput: ClassifyCallsInput = {
        calls: body.calls,
        effects,
        registry,
        config,
        component,
        candidate,
        file,
        language: extractLanguageFromId(candidate.id),
        imports,
        dropCFilter,
        timeoutEvents,
        vocab,
      }
      if (config.classifyTimeoutMs !== undefined)
        classifyCallsInput.classifyTimeoutMs = config.classifyTimeoutMs
      const {
        effects: classifiedEffects,
        calls: keptCalls,
        dynamicCallSites: fileDynamicCallSites,
      } = classifyCalls(classifyCallsInput)
      dynamicCallSites.push(...fileDynamicCallSites)

      const normalized = language.normalizeAst(candidate)
      symbols.push(
        buildKeptSymbol({
          candidate,
          language: extractLanguageFromId(candidate.id),
          component,
          rules: body.rules,
          effects: classifiedEffects,
          calls: keptCalls,
          normalizedAstString: normalized,
          confidence,
        }),
      )
    }

    log.debug(`scan/pipeline: ${file.path} produced ${symbols.length} symbols`)

    return {
      kind: "extracted",
      path: file.path,
      parseErrors,
      symbols,
      imports,
      timeoutEvents,
      dynamicCallSites,
    }
  } finally {
    if (parseResult.tree !== null) {
      releaseParsedTree(language, parseResult.tree, file, input.treeReleaseFailures)
    }
  }
}

function releaseParsedTree(
  language: LanguagePlugin,
  tree: ParsedTree,
  file: SourceFile,
  failures: TreeReleaseFailure[],
): void {
  const release: unknown = language.releaseTree
  if (release === undefined || release === null) return

  const record = (detail: string): void => {
    failures.push({ plugin: language.manifest.name, file: file.path, detail })
  }

  if (typeof release !== "function") {
    record(`releaseTree is ${describeJsonType(release)}, not a function`)
    return
  }
  try {
    ;(release as (this: LanguagePlugin, tree: ParsedTree) => void).call(language, tree)
  } catch (error) {
    record(describeThrown(error))
  }
}
