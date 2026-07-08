import type {
  BodyExtraction,
  Call,
  Config,
  DropHint,
  Effect,
  EffectPlugin,
  ExtKind,
  ExtractionContext,
  FrameworkPlugin,
  ImportEdge,
  Symbol as IRSymbol,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParseError,
  SourceFile,
  SymbolCandidate,
  SymbolClassification,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { CoreError } from "../errors"
import { computeSymbolFingerprint, ZERO_FINGERPRINT } from "../fingerprint"
import { decideSymbolDrop } from "./drop-b"
import type { DropCFilter } from "./drop-c"
import { type ClassifyTimeoutEvent, classifyWithTimeout } from "./timeout"

/**
 * Per-file pipeline output. The Symbols carry finalized fingerprints and are already
 * routed through Category B / C drop rules. `imports` is preserved so caller-side
 * dependency extraction (future dependency-extraction pass) has access without re-parsing.
 */
export interface FilePipelineResult {
  symbols: IRSymbol[]
  imports: readonly ImportEdge[]
  parseErrors: readonly ParseError[]
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  /**
   * True when the language plugin's `parseFile` returned a null tree — the file could
   * not be parsed at all. Recoverable errors (non-null tree + errors[]) do not flip
   * this flag; those files are still counted as parsed even when they carry warnings.
   */
  terminalParseFailure: boolean
  /** POSIX-relative path of the file. */
  path: string
}

export interface FilePipelineInput {
  file: SourceFile
  language: LanguagePlugin
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  config: Config
  dropCFilter: DropCFilter
  log: Logger
  classifyTimeoutMs?: number
}

/**
 * Run the extraction pipeline for a single file. The steps follow
 * design/details/lang-plugin.md §5.3 (extraction order) and effect-plugin.md §5.1
 * (first-match-wins) in order:
 *
 *   1. parse the file — a null tree is a terminal parse failure, everything else is
 *      surfaced as a recoverable error and we keep going.
 *   2. `extractSymbols` — the raw SymbolCandidate list.
 *   3. framework `classifySymbol` — first non-null result wins; the returned extKind
 *      and decoratorBoundaries are merged into the Candidate before walkBody sees it,
 *      so downstream effect classifiers can key on `owner.extKind`.
 *   4. shape drop check (Cat B / language `symbolDropHint`) — a Symbol that ends up
 *      dropped keeps its identity in the IR but skips walkBody / fingerprint work.
 *   5. `walkBody` — rules + CallCandidate[]. Category C `keep`/`suppress` filtering
 *      runs on the resulting calls.
 *   6. effect `classify` — first non-null classification wins; surviving calls stay in
 *      `Symbol.calls[]`, classified calls move to `Symbol.effects[]`.
 *   7. `normalizeAst` + `computeSymbolFingerprint` — locks the Symbol against later
 *      churn.
 */
export async function runFilePipeline(input: FilePipelineInput): Promise<FilePipelineResult> {
  const { file, language, frameworks, effects, registry, config, dropCFilter, log } = input

  const parseResult = await language.parseFile(file)
  const parseErrors = parseResult.errors
  const timeoutEvents: ClassifyTimeoutEvent[] = []

  if (parseResult.tree === null) {
    return {
      symbols: [],
      imports: parseResult.imports,
      parseErrors,
      timeoutEvents,
      terminalParseFailure: true,
      path: file.path,
    }
  }

  const extractCtx: ExtractionContext = { file, registry, config }
  const candidates = language.extractSymbols(
    parseResult.tree,
    extractCtx,
  ) as SymbolCandidate<OpaqueAstNode>[]
  const symbols: IRSymbol[] = []

  for (const raw of candidates) {
    const candidate = mergeFrameworkClassification(raw, frameworks, extractCtx)
    const dropReason = decideDropReason(candidate, language, extractCtx)

    if (dropReason !== null) {
      symbols.push(buildDroppedSymbol(candidate, dropReason, extractLanguageFromId(candidate.id)))
      continue
    }

    const walkCtx: WalkContext<OpaqueAstNode> = { ...extractCtx, symbol: candidate }
    const body: BodyExtraction = language.walkBody(candidate, walkCtx)

    const classifyCallsInput: ClassifyCallsInput = {
      calls: body.calls,
      effects,
      registry,
      config,
      candidate,
      file,
      language: extractLanguageFromId(candidate.id),
      imports: parseResult.imports,
      dropCFilter,
      timeoutEvents,
    }
    if (input.classifyTimeoutMs !== undefined)
      classifyCallsInput.classifyTimeoutMs = input.classifyTimeoutMs
    const { effects: classifiedEffects, calls: keptCalls } = classifyCalls(classifyCallsInput)

    const normalized = language.normalizeAst(candidate)
    symbols.push(
      buildKeptSymbol({
        candidate,
        language: extractLanguageFromId(candidate.id),
        rules: body.rules,
        effects: classifiedEffects,
        calls: keptCalls,
        normalizedAstString: normalized,
      }),
    )
  }

  log.debug(`scan/pipeline: ${file.path} produced ${symbols.length} symbols`)

  return {
    symbols,
    imports: parseResult.imports,
    parseErrors,
    timeoutEvents,
    terminalParseFailure: false,
    path: file.path,
  }
}

function mergeFrameworkClassification(
  candidate: SymbolCandidate<OpaqueAstNode>,
  frameworks: readonly FrameworkPlugin[],
  ctx: ExtractionContext,
): SymbolCandidate<OpaqueAstNode> {
  for (const framework of frameworks) {
    const result = framework.classifySymbol(candidate, ctx) as SymbolClassification | null
    if (result === null) continue
    const decorators = candidate.decorators.map((d) => {
      const override = result.decoratorBoundaries?.[d.name]
      return override === undefined ? d : { ...d, boundary: override }
    })
    return {
      ...candidate,
      extKind: (result.extKind ?? candidate.extKind) as ExtKind,
      decorators,
      derivedBy: mergeDerivedBy(candidate.derivedBy, result.derivedBy),
    }
  }
  return candidate
}

function mergeDerivedBy(current: readonly string[], addition: string): string[] {
  // Framework plugins fold multi-signal reasons into `derivedBy` with `;` as a
  // separator (see framework-next). Split the addition back into individual entries so
  // downstream consumers observe the same array shape as everywhere else in the IR.
  const parts = addition.split(";").filter((s) => s.length > 0)
  const merged = [...current]
  for (const p of parts) if (!merged.includes(p)) merged.push(p)
  return merged
}

function decideDropReason(
  candidate: SymbolCandidate<OpaqueAstNode>,
  language: LanguagePlugin,
  ctx: ExtractionContext,
): string | null {
  const core = decideSymbolDrop(candidate)
  if (core !== null) return core
  const hint: DropHint | null = language.symbolDropHint?.(candidate, ctx) ?? null
  return hint?.reason ?? null
}

interface ClassifyCallsInput {
  calls: readonly import("@aburi/types").CallCandidate[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  config: Config
  candidate: SymbolCandidate<OpaqueAstNode>
  file: SourceFile
  language: string
  imports: readonly ImportEdge[]
  dropCFilter: DropCFilter
  timeoutEvents: ClassifyTimeoutEvent[]
  classifyTimeoutMs?: number
}

function classifyCalls(input: ClassifyCallsInput): {
  effects: Effect[]
  calls: Call[]
} {
  const classifiedEffects: Effect[] = []
  const survivingCalls: Call[] = []
  const owner = {
    id: input.candidate.id,
    kind: input.candidate.kind,
    name: input.candidate.name,
    extKind: input.candidate.extKind,
    decorators: input.candidate.decorators.map((d) => ({ name: d.name, boundary: d.boundary })),
    component: null,
  }

  for (const call of input.calls) {
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
      classifiedEffects.push({
        id: result.effectId,
        target: call.target,
        line: call.line,
        plugin: effect.manifest.name,
        confidence: result.confidence,
      })
      classified = true
      break
    }
    if (!classified) {
      survivingCalls.push({ target: call.target, line: call.line, resolved: null })
    }
  }

  classifiedEffects.sort(byTargetThenLine)
  survivingCalls.sort(byTargetThenLine)
  return { effects: classifiedEffects, calls: survivingCalls }
}

function byTargetThenLine(
  a: { target: string; line: number },
  b: { target: string; line: number },
): number {
  if (a.target < b.target) return -1
  if (a.target > b.target) return 1
  return a.line - b.line
}

/**
 * Recover the LanguageId from a Symbol id. The id contract is
 * `<language>:<posix-relative-path>#<qualified-name>` per ir-schema §3.1, so the
 * language sits before the first colon. An id without a colon means the language
 * plugin violated the id contract — throw so the scan surfaces the bug loudly rather
 * than emitting a Symbol with an empty language that silently passes the (currently
 * language-agnostic) integrity check.
 */
function extractLanguageFromId(id: string): string {
  const colon = id.indexOf(":")
  if (colon <= 0) {
    throw new CoreError(
      `Symbol id "${id}" does not carry a language prefix; the language plugin violated the Symbol.id contract (\`<language>:<file>#<qname>\`).`,
      { code: "scan-plugin-misconfigured", value: id },
    )
  }
  return id.slice(0, colon)
}

function buildDroppedSymbol(
  candidate: SymbolCandidate<OpaqueAstNode>,
  reason: string,
  language: string,
): IRSymbol {
  return {
    id: candidate.id,
    kind: candidate.kind,
    extKind: candidate.extKind,
    name: candidate.name,
    language,
    visibility: candidate.visibility,
    decorators: [...candidate.decorators],
    signature: candidate.signature,
    rules: [],
    effects: [],
    calls: [],
    source: candidate.source,
    fingerprint: { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT },
    confidence: "high",
    derivedBy: [...candidate.derivedBy],
    dropped: true,
    dropReason: reason,
  }
}

interface BuildKeptSymbolInput {
  candidate: SymbolCandidate<OpaqueAstNode>
  language: string
  rules: import("@aburi/types").Rule[]
  effects: Effect[]
  calls: Call[]
  normalizedAstString: string
}

function buildKeptSymbol(input: BuildKeptSymbolInput): IRSymbol {
  const base: IRSymbol = {
    id: input.candidate.id,
    kind: input.candidate.kind,
    extKind: input.candidate.extKind,
    name: input.candidate.name,
    language: input.language,
    visibility: input.candidate.visibility,
    // Sort every list-field by `.line` before it enters the IR. Integrity invariant
    // #11 (`integrity.ts:284-311`) demands monotonic `.line` on `decorators` /
    // `rules` / `effects` / `calls` — but the upstream producers do NOT guarantee
    // that ordering on their own:
    //   - `decorators` from the language plugin land in AST traversal order, which
    //     tracks source order for stacked decorators but is not spelled out as a
    //     plugin contract.
    //   - `rules` come out of `walkBody` in visit order (branch tails after
    //     branch bodies, `else` before `try/finally`), so an integrity-safe
    //     ordering has to be applied here.
    //   - `effects` and `calls` were both re-sorted by `byTargetThenLine` in
    //     `classifyCalls` (see pipeline.ts:273-274). That satisfies human
    //     readability but violates monotonic `.line` the moment a Symbol has two
    //     entries whose target-alpha order is inverted from their source line.
    // A stable line sort here restores invariant #11 without disturbing the
    // relative order of same-line entries — same-line entries keep whatever
    // order the producer gave them (schema §17 says "appearance order").
    decorators: [...input.candidate.decorators].sort((a, b) => a.line - b.line),
    signature: input.candidate.signature,
    rules: [...input.rules].sort((a, b) => a.line - b.line),
    effects: [...input.effects].sort((a, b) => a.line - b.line),
    calls: [...input.calls].sort((a, b) => a.line - b.line),
    source: input.candidate.source,
    fingerprint: { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT },
    confidence: "high",
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
