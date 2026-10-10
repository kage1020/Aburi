import type {
  BodyExtraction,
  Call,
  CallCandidate,
  ComponentId,
  Confidence,
  Config,
  Decorator,
  DropHint,
  Effect,
  EffectPlugin,
  ExtKind,
  ExtractionContext,
  FrameworkClassifyContext,
  FrameworkPlugin,
  ImportEdge,
  Symbol as IRSymbol,
  LanguageId,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  OwnerDecorator,
  OwnerSummary,
  ParsedTree,
  ParseError,
  SourceFile,
  SymbolCandidate,
  SymbolClassification,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { makeCallSiteKey } from "../call-site"
import { toNfc } from "../codepoints"
import { CoreError } from "../errors"
import { computeSymbolFingerprint, ZERO_FINGERPRINT } from "../fingerprint"
import { makeLanguageId } from "../id"
import { normalizeRuleStrings } from "../rule-text"
import { decideSymbolDrop } from "./drop-b"
import type { DropCFilter } from "./drop-c"
import { describeJsonType, describeThrown } from "./faults"
import {
  type ClassifyTimeoutEvent,
  classifyWithTimeout,
  type ParseTimeoutEvent,
  startParseDeadline,
} from "./timeout"
import type { VocabCheck } from "./vocab"

interface FileOutcomeCommon {
  /** POSIX-relative path of the file. */
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
  /** Manifest name of the language plugin that was asked to release the tree. */
  plugin: string
  /** Workspace-relative POSIX path of the file whose tree it was. */
  file: string
  /** What went wrong: the plugin's own message, or how its `releaseTree` broke the contract. */
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

interface FrameworkMergeResult {
  candidate: SymbolCandidate<OpaqueAstNode>
  confidence: Confidence
  /** Manifest name of the plugin that set `candidate.extKind`, or `null` when none is set. */
  extKindBy: string | null
}

function decoratorBoundaryKey(decorator: Decorator): string {
  const { qualifier } = decorator
  return qualifier === undefined ? decorator.name : `${qualifier}.${decorator.name}`
}

function mergeFrameworkClassification(
  candidate: SymbolCandidate<OpaqueAstNode>,
  frameworks: readonly FrameworkPlugin[],
  ctx: FrameworkClassifyContext,
  languagePlugin: string,
): FrameworkMergeResult {
  const extractedBy = candidate.extKind === null ? null : languagePlugin
  for (const framework of frameworks) {
    const result = framework.classifySymbol(candidate, ctx) as SymbolClassification | null
    if (result === null) continue
    const decorators = candidate.decorators.map((d) => {
      const override = result.decoratorBoundaries?.[decoratorBoundaryKey(d)]
      return override === undefined ? d : { ...d, boundary: override }
    })
    return {
      candidate: {
        ...candidate,
        extKind: (result.extKind ?? candidate.extKind) as ExtKind,
        decorators,
        derivedBy: mergeDerivedBy(candidate.derivedBy, result.derivedBy),
      },
      confidence: result.confidence ?? "high",
      extKindBy:
        result.extKind === undefined || result.extKind === null
          ? extractedBy
          : framework.manifest.name,
    }
  }
  return { candidate, confidence: "high", extKindBy: extractedBy }
}

function mergeDerivedBy(current: readonly string[], addition: string): string[] {
  const parts = addition.split(";").filter((s) => s.length > 0)
  const merged = [...current]
  for (const p of parts) if (!merged.includes(p)) merged.push(p)
  return merged
}

function decideDropReason(
  candidate: SymbolCandidate<OpaqueAstNode>,
  language: LanguagePlugin,
  frameworks: readonly FrameworkPlugin[],
  ctx: FrameworkClassifyContext,
): string | null {
  const core = decideSymbolDrop(candidate)
  if (core !== null) return core
  for (const framework of frameworks) {
    const hint: DropHint | null = framework.symbolDropHint?.(candidate, ctx) ?? null
    if (hint !== null) return hint.reason
  }
  const hint: DropHint | null = language.symbolDropHint?.(candidate, ctx) ?? null
  return hint?.reason ?? null
}

interface ClassifyCallsInput {
  calls: readonly CallCandidate[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  config: Config
  component: ComponentId | null
  candidate: SymbolCandidate<OpaqueAstNode>
  file: SourceFile
  language: LanguageId
  imports: readonly ImportEdge[]
  dropCFilter: DropCFilter
  timeoutEvents: ClassifyTimeoutEvent[]
  vocab: VocabCheck
  classifyTimeoutMs?: number
}

function normalizeCandidateStrings(
  candidate: SymbolCandidate<OpaqueAstNode>,
): SymbolCandidate<OpaqueAstNode> {
  const file = toNfc(candidate.source.file)
  const signature = normalizeSignatureStrings(candidate.signature)
  const decorators = normalizeDecoratorNames(candidate.decorators)
  if (
    file === candidate.source.file &&
    signature === candidate.signature &&
    decorators === candidate.decorators
  ) {
    return candidate
  }
  return { ...candidate, source: { ...candidate.source, file }, signature, decorators }
}

/** `items.map(transform)`, except that `items` itself comes back when no element changed. */
function mapPreservingIdentity<T>(items: T[], transform: (item: T) => T): T[] {
  let changed = false
  const next = items.map((item) => {
    const out = transform(item)
    if (out !== item) changed = true
    return out
  })
  return changed ? next : items
}

function normalizeDecoratorNames(
  decorators: SymbolCandidate<OpaqueAstNode>["decorators"],
): SymbolCandidate<OpaqueAstNode>["decorators"] {
  return mapPreservingIdentity(decorators, (decorator) => {
    const name = toNfc(decorator.name)
    const written = decorator.qualifier
    const qualifier = typeof written === "string" ? toNfc(written) : written
    if (name === decorator.name && qualifier === written) return decorator
    const next = { ...decorator, name }
    if (qualifier !== undefined) next.qualifier = qualifier
    return next
  })
}

function normalizeSignatureStrings<T extends SymbolCandidate<OpaqueAstNode>["signature"]>(
  signature: T,
): T {
  if (signature === null || signature === undefined) return signature
  const inputs = mapPreservingIdentity(signature.inputs, (input) => {
    const name = toNfc(input.name)
    const written = input.bindings
    if (written === undefined) return name === input.name ? input : { ...input, name }
    const bindings = mapPreservingIdentity(written, toNfc)
    return name === input.name && bindings === written ? input : { ...input, name, bindings }
  })
  return inputs === signature.inputs ? signature : ({ ...signature, inputs } as T)
}

function normalizeImportEdge(edge: ImportEdge): ImportEdge {
  const source = toNfc(edge.source)
  const binding = edge.namespaceBinding
  const namespaceBinding = typeof binding === "string" ? toNfc(binding) : binding
  const symbols = edge.symbols === "*" ? edge.symbols : mapPreservingIdentity(edge.symbols, toNfc)
  if (
    source === edge.source &&
    namespaceBinding === edge.namespaceBinding &&
    symbols === edge.symbols
  ) {
    return edge
  }
  const next: ImportEdge = { ...edge, source, symbols }
  if (namespaceBinding !== undefined) next.namespaceBinding = namespaceBinding
  return next
}

function normalizeCallStrings(call: CallCandidate): CallCandidate {
  const target = toNfc(call.target)
  return target === call.target ? call : { ...call, target }
}

function ownerDecorator(decorator: Decorator): OwnerDecorator {
  const { name, qualifier, boundary } = decorator
  return qualifier === undefined ? { name, boundary } : { name, qualifier, boundary }
}

function classifyCalls(input: ClassifyCallsInput): {
  effects: Effect[]
  calls: Call[]
  dynamicCallSites: string[]
} {
  const classifiedEffects: Effect[] = []
  const survivingCalls: Call[] = []
  const dynamicCallSites: string[] = []
  const owner: OwnerSummary = {
    id: input.candidate.id,
    kind: input.candidate.kind,
    name: input.candidate.name,
    extKind: input.candidate.extKind,
    decorators: input.candidate.decorators.map(ownerDecorator),
    component: input.component,
  }

  for (const produced of input.calls) {
    const call = normalizeCallStrings(produced)
    if (input.dropCFilter.shouldDropCall(call)) continue

    const ctx = {
      owner,
      file: { path: input.file.path, imports: [...input.imports] },
      language: input.language,
      registry: input.registry,
      config: input.config,
    }

    let classified = false
    for (const effect of input.effects) {
      const timeoutOptions: import("./timeout").ClassifyWithTimeoutOptions = {
        onTimeout: (event) => {
          input.timeoutEvents.push(event)
        },
      }
      if (input.classifyTimeoutMs !== undefined) timeoutOptions.timeoutMs = input.classifyTimeoutMs
      const result = classifyWithTimeout(
        effect,
        call,
        ctx,
        { symbolId: input.candidate.id, file: input.file.path },
        timeoutOptions,
      )
      if (result === null) continue
      input.vocab.effect({
        value: result.effectId,
        plugin: effect.manifest.name,
        file: input.file.path,
        line: call.line,
        symbol: input.candidate.id,
      })
      classifiedEffects.push({
        id: result.effectId,
        target: call.target,
        line: call.line,
        plugin: effect.manifest.name,
        confidence: result.confidence,
        derivedBy: result.derivedBy,
      })
      classified = true
      break
    }
    if (!classified) {
      survivingCalls.push({ target: call.target, line: call.line, resolved: null })
      if (call.dynamicReceiver === true) {
        dynamicCallSites.push(makeCallSiteKey(input.file.path, call.line, call.target))
      }
    }
  }

  classifiedEffects.sort(byTargetThenLine)
  survivingCalls.sort(byTargetThenLine)
  return { effects: classifiedEffects, calls: survivingCalls, dynamicCallSites }
}

function byTargetThenLine(
  a: { target: string; line?: number },
  b: { target: string; line?: number },
): number {
  if (a.target < b.target) return -1
  if (a.target > b.target) return 1
  return (a.line ?? 0) - (b.line ?? 0)
}

function extractLanguageFromId(id: string): LanguageId {
  const colon = id.indexOf(":")
  if (colon <= 0) {
    throw new CoreError(
      `Symbol id "${id}" does not carry a language prefix; the language plugin violated the Symbol.id contract (\`<language>:<file>#<qname>\`).`,
      { code: "scan-plugin-misconfigured", value: id },
    )
  }
  return makeLanguageId(id.slice(0, colon))
}

function buildDroppedSymbol(
  candidate: SymbolCandidate<OpaqueAstNode>,
  reason: string,
  language: LanguageId,
  component: ComponentId | null,
  frameworkConfidence: Confidence,
): IRSymbol {
  return {
    id: candidate.id,
    kind: candidate.kind,
    extKind: candidate.extKind,
    name: candidate.name,
    language,
    component,
    visibility: candidate.visibility,
    decorators: [...candidate.decorators],
    signature: candidate.signature,
    rules: [],
    effects: [],
    calls: [],
    source: candidate.source,
    fingerprint: { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT },
    confidence: frameworkConfidence,
    derivedBy: [...candidate.derivedBy],
    dropped: true,
    dropReason: reason,
  }
}

interface BuildKeptSymbolInput {
  candidate: SymbolCandidate<OpaqueAstNode>
  language: LanguageId
  component: ComponentId | null
  rules: import("@aburi/types").Rule[]
  effects: Effect[]
  calls: Call[]
  normalizedAstString: string
  /** Resolved by mergeFrameworkClassification — always a concrete Confidence. */
  confidence: Confidence
}

function buildKeptSymbol(input: BuildKeptSymbolInput): IRSymbol {
  const base: IRSymbol = {
    id: input.candidate.id,
    kind: input.candidate.kind,
    extKind: input.candidate.extKind,
    name: input.candidate.name,
    language: input.language,
    component: input.component,
    visibility: input.candidate.visibility,
    decorators: [...input.candidate.decorators].sort((a, b) => a.line - b.line),
    signature: input.candidate.signature,
    rules: input.rules.map(normalizeRuleStrings).sort((a, b) => a.line - b.line),
    effects: [...input.effects].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    calls: [...input.calls].sort((a, b) => a.line - b.line),
    source: input.candidate.source,
    fingerprint: { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT },
    confidence: input.confidence,
    derivedBy: [...input.candidate.derivedBy],
    dropped: false,
    dropReason: null,
  }
  base.fingerprint = computeSymbolFingerprint({
    symbol: base,
    normalizedAstString: input.normalizedAstString,
  })
  return base
}
