import type {
  BodyExtraction,
  Call,
  CallCandidate,
  Confidence,
  Config,
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
  ParseError,
  SourceFile,
  SymbolCandidate,
  SymbolClassification,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { makeCallSiteKey } from "../callgraph"
import { CoreError } from "../errors"
import { computeSymbolFingerprint, ZERO_FINGERPRINT } from "../fingerprint"
import { makeLanguageId } from "../id"
import { decideSymbolDrop } from "./drop-b"
import type { DropCFilter } from "./drop-c"
import {
  type ClassifyTimeoutEvent,
  classifyWithTimeout,
  type ParseTimeoutEvent,
  startParseDeadline,
} from "./timeout"

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
  /**
   * Set when the file overran `config.parseTimeoutMs` and was abandoned. Every other field
   * is then empty: an abandoned file contributes nothing to the IR, because the alternative
   * — keeping whichever Symbols it managed to produce first — would make the Document
   * depend on how fast the machine was that day. The caller records the file as skipped and
   * excludes it from `parsedFiles`.
   *
   * Two exceptions to "every other field is empty". `parseErrors` survives, because it is
   * diagnostic rather than IR and because a slow parse is often a slow parse *of broken
   * input* — a reader told only about the budget would go raise it instead of fixing the
   * syntax. `imports` does not, which is the one place this differs from a terminal parse
   * failure: that path keeps its edges, because a file that could not be parsed at all still
   * told us truthfully what it imports, whereas here the file is being withdrawn
   * deliberately, and an import list is only ever consulted on behalf of the calls in its
   * own file — of which an abandoned file has none.
   *
   * Never set together with `terminalParseFailure`. Both feed `parsedFiles`, by different
   * subtractions, so a file carrying both would be counted out of it twice.
   */
  parseTimeout: ParseTimeoutEvent | null
  /** POSIX-relative path of the file. */
  path: string
  /**
   * `makeCallSiteKey` keys for the surviving calls whose receiver the language
   * plugin reported as an expression. `Call` is a schema type and cannot carry
   * the flag, so it rides beside the Symbols until `resolveCallGraph` consumes
   * it for the `dynamic` diagnostic bucket (call-resolution.md §8.1).
   */
  dynamicCallSites: readonly string[]
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
  /** `config.parseTimeoutMs`. Omitted means the lang-plugin.md §7.1.2 default. */
  parseTimeoutMs?: number
}

/**
 * Run the extraction pipeline for a single file. The steps follow
 * docs/design/lang-plugin.md §5.3 (extraction order) and effect-plugin.md §5.1
 * (first-match-wins) in order:
 *
 *   1. parse the file — a null tree is a terminal parse failure, everything else is
 *      surfaced as a recoverable error and we keep going.
 *   2. `extractSymbols` — the raw SymbolCandidate list.
 *   3. framework `classifySymbol` — first non-null result wins; the returned extKind
 *      and decoratorBoundaries are merged into the Candidate before walkBody sees it,
 *      so downstream effect classifiers can key on `owner.extKind`. The classifiers see
 *      the file's import edges alongside the Candidate, which is what lets a decorator
 *      renamed on import still be recognized and one from a foreign package be doubted.
 *   4. shape drop check (Cat B / language `symbolDropHint`) — a Symbol that ends up
 *      dropped keeps its identity in the IR but skips walkBody / fingerprint work.
 *   5. `walkBody` — rules + CallCandidate[]. Category C `keep`/`suppress` filtering
 *      runs on the resulting calls.
 *   6. effect `classify` — first non-null classification wins; surviving calls stay in
 *      `Symbol.calls[]`, classified calls move to `Symbol.effects[]`.
 *   7. `normalizeAst` + `computeSymbolFingerprint` — locks the Symbol against later
 *      churn.
 *
 * The file's `parseTimeoutMs` budget (lang-plugin.md §7.1.2) is read after step 1, after
 * step 2, and before each iteration of 3-7. A plugin call cannot be interrupted once it has
 * started, so a budget can only be enforced between them; these three are the readings that
 * bound the work still to come, and a file found over budget at one of them is abandoned.
 */
export async function runFilePipeline(input: FilePipelineInput): Promise<FilePipelineResult> {
  const { file, language, frameworks, effects, registry, config, dropCFilter, log } = input

  const deadline = startParseDeadline(input.parseTimeoutMs)
  // Everything the file produced is withdrawn except its parse errors. Those are the one
  // output that is diagnostic rather than IR, and the one a slow file most needs to keep:
  // backtracking over malformed input is a common reason for a slow parse, so a timeout
  // that swallowed them would tell the reader to raise `parseTimeoutMs` when the fix is
  // the syntax. `parseErrors` is in scope at every call — the parse has always returned.
  const abandon = (): FilePipelineResult => ({
    symbols: [],
    imports: [],
    parseErrors,
    timeoutEvents: [],
    terminalParseFailure: false,
    parseTimeout: {
      file: file.path,
      budgetMs: deadline.budgetMs,
      elapsedMs: deadline.elapsedMs(),
    },
    path: file.path,
    dynamicCallSites: [],
  })

  const parseResult = await language.parseFile(file)
  const parseErrors = parseResult.errors
  const timeoutEvents: ClassifyTimeoutEvent[] = []
  // Normalized before the early return as well: a terminal parse failure still hands its
  // import edges to the caller, and dependency extraction compares them the same way.
  const imports = parseResult.imports.map(normalizeImportEdge)

  // Read before the budget. A file with no tree at all is already excluded from
  // `parsedFiles` by the count it feeds, and the two flags must not both be set or the
  // caller would subtract the same file twice. Between the two claims the parse failure is
  // the one that names a fix.
  if (parseResult.tree === null) {
    return {
      symbols: [],
      imports,
      parseErrors,
      timeoutEvents,
      terminalParseFailure: true,
      parseTimeout: null,
      path: file.path,
      dynamicCallSites: [],
    }
  }

  if (deadline.expired()) return abandon()

  const extractCtx: ExtractionContext = { file, registry, config }
  const candidates = language.extractSymbols(
    parseResult.tree,
    extractCtx,
  ) as SymbolCandidate<OpaqueAstNode>[]
  if (deadline.expired()) return abandon()

  const symbols: IRSymbol[] = []
  const dynamicCallSites: string[] = []

  // Built once for the file rather than per candidate: every Symbol in a file is classified
  // against the same import list, and a decorator-driven framework plugin reads it for every
  // one of them.
  const frameworkCtx: FrameworkClassifyContext = { ...extractCtx, imports }

  for (const raw of candidates) {
    if (deadline.expired()) return abandon()

    const { candidate, confidence } = mergeFrameworkClassification(
      normalizeCandidateStrings(raw),
      frameworks,
      frameworkCtx,
    )
    const dropReason = decideDropReason(candidate, language, extractCtx)

    if (dropReason !== null) {
      symbols.push(
        buildDroppedSymbol(candidate, dropReason, extractLanguageFromId(candidate.id), confidence),
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
      candidate,
      file,
      language: extractLanguageFromId(candidate.id),
      imports,
      dropCFilter,
      timeoutEvents,
    }
    if (input.classifyTimeoutMs !== undefined)
      classifyCallsInput.classifyTimeoutMs = input.classifyTimeoutMs
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
    symbols,
    imports,
    parseErrors,
    timeoutEvents,
    terminalParseFailure: false,
    parseTimeout: null,
    path: file.path,
    dynamicCallSites,
  }
}

interface FrameworkMergeResult {
  candidate: SymbolCandidate<OpaqueAstNode>
  /** Concrete Symbol.confidence. Resolved once, at this boundary: any classifier that
   * omitted `confidence` (or no classifier matched at all) collapses to "high" here so
   * downstream code only ever sees a single encoding. */
  confidence: Confidence
}

function mergeFrameworkClassification(
  candidate: SymbolCandidate<OpaqueAstNode>,
  frameworks: readonly FrameworkPlugin[],
  ctx: FrameworkClassifyContext,
): FrameworkMergeResult {
  for (const framework of frameworks) {
    const result = framework.classifySymbol(candidate, ctx) as SymbolClassification | null
    if (result === null) continue
    const decorators = candidate.decorators.map((d) => {
      const override = result.decoratorBoundaries?.[d.name]
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
    }
  }
  return { candidate, confidence: "high" }
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
  calls: readonly CallCandidate[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  config: Config
  candidate: SymbolCandidate<OpaqueAstNode>
  file: SourceFile
  language: LanguageId
  imports: readonly ImportEdge[]
  dropCFilter: DropCFilter
  timeoutEvents: ClassifyTimeoutEvent[]
  classifyTimeoutMs?: number
}

/**
 * Put the strings a language plugin hands back into Unicode NFC, the form ir-schema.md §1.2
 * defines every Document string to be in.
 *
 * A plugin reads identifiers and paths out of source bytes, so whichever spelling a file
 * carries is the spelling it returns. This is the boundary where plugin output becomes IR,
 * and normalization has to be total across it: a value normalized here is then compared
 * against values that arrive from elsewhere, so leaving one side alone turns a match into a
 * miss. What is covered:
 *
 * - `source.file`, which §14 invariant #19 checks and which `resolveCallGraph` matches
 *   against call-site keys built from the already-normalized `SourceFile.path`.
 * - `signature.inputs[].name`, which the call resolver compares against a call's head
 *   segment to decide that a parameter shadows a Symbol of the same name
 *   (call-resolution.md §4.2). Missing that comparison emits an edge to an unrelated
 *   Symbol, which then carries effects through propagation.
 *
 * `id` is deliberately not touched: it is constructed rather than read, `makeSymbolId`
 * normalizes it there, and quietly repairing one asserted by hand would hide the plugin bug
 * invariant #17 exists to report. `name` needs nothing either — it is held to the
 * qualified-name grammar, which is ASCII-only, so it normalizes to itself.
 *
 * The candidate is returned unchanged when nothing differs, so the ASCII case — every
 * candidate in an ordinary scan — allocates nothing.
 */
function normalizeCandidateStrings(
  candidate: SymbolCandidate<OpaqueAstNode>,
): SymbolCandidate<OpaqueAstNode> {
  const file = candidate.source.file.normalize("NFC")
  const signature = normalizeSignatureStrings(candidate.signature)
  if (file === candidate.source.file && signature === candidate.signature) return candidate
  return { ...candidate, source: { ...candidate.source, file }, signature }
}

/**
 * Only `inputs[].name` is normalized. The type strings beside it are quotations of source
 * text (§1.2): their spelling decides nothing, and rewriting one would misquote the
 * declaration the Document is reporting.
 */
function normalizeSignatureStrings<T extends SymbolCandidate<OpaqueAstNode>["signature"]>(
  signature: T,
): T {
  if (signature === null || signature === undefined) return signature
  let changed = false
  const inputs = signature.inputs.map((input) => {
    const name = input.name.normalize("NFC")
    if (name === input.name) return input
    changed = true
    return { ...input, name }
  })
  return changed ? ({ ...signature, inputs } as T) : signature
}

/**
 * The same treatment for an import edge, whose three fields are all matched against strings
 * this boundary normalizes.
 *
 * `namespaceBinding` and the local half of `symbols[]` are compared against a call's head
 * segment, and `source` is resolved into a file path and compared against the discovered
 * file set — which `toPosixRelative` normalized. A miss here is silent: the call falls into
 * the `no-match` diagnostic bucket rather than `external`, which is precisely the state that
 * sends a reviewer looking for a typo that does not exist.
 */
function normalizeImportEdge(edge: ImportEdge): ImportEdge {
  const source = edge.source.normalize("NFC")
  const binding = edge.namespaceBinding
  const namespaceBinding = typeof binding === "string" ? binding.normalize("NFC") : binding
  const symbols =
    edge.symbols === "*" ? edge.symbols : edge.symbols.map((entry) => entry.normalize("NFC"))
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

/**
 * The same treatment for a call, which carries the string the IR orders by.
 *
 * `target` reaches the Document through one of two fields — `calls[].target` when nothing
 * claims the call, `effects[].target` when an effect plugin does (§9.3; the two are
 * exclusive). The second is a sort key: `propagateEffects` orders propagated entries by
 * `(id, target)` and integrity invariant #11 verifies that order against the in-memory
 * string, while the serializer writes the normalized one. Two spellings there put a Document
 * on disk out of the order it declares.
 *
 * Normalized before the drop filter and before any classifier sees it, so a plugin cannot
 * be handed a spelling that differs from the one recorded against its own answer.
 */
function normalizeCallStrings(call: CallCandidate): CallCandidate {
  const target = call.target.normalize("NFC")
  return target === call.target ? call : { ...call, target }
}

function classifyCalls(input: ClassifyCallsInput): {
  effects: Effect[]
  calls: Call[]
  dynamicCallSites: string[]
} {
  const classifiedEffects: Effect[] = []
  const survivingCalls: Call[] = []
  const dynamicCallSites: string[] = []
  const owner = {
    id: input.candidate.id,
    kind: input.candidate.kind,
    name: input.candidate.name,
    extKind: input.candidate.extKind,
    decorators: input.candidate.decorators.map((d) => ({ name: d.name, boundary: d.boundary })),
    component: null,
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
  // Effect.line became optional in the schema when the propagation pass landed
  // (effect-propagation.md §5.1 — propagated entries omit line). At this call
  // site, both inputs are locally-detected effects seeded from `call.line`, so
  // `line` is present; the ?? 0 fallback is a type-level completeness hedge and
  // never runs.
  return (a.line ?? 0) - (b.line ?? 0)
}

/**
 * Recover the LanguageId from a Symbol id. The id contract is
 * `<language>:<posix-relative-path>#<qualified-name>` per ir-schema §3.1, so the
 * language sits before the first colon. An id without a colon means the language
 * plugin violated the id contract — throw so the scan surfaces the bug loudly rather
 * than emitting a Symbol with an empty language that silently passes the (currently
 * language-agnostic) integrity check.
 */
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
  frameworkConfidence: Confidence,
): IRSymbol {
  return {
    id: candidate.id,
    kind: candidate.kind,
    extKind: candidate.extKind,
    name: candidate.name,
    language,
    // Class A per ir-schema.md §1.1: the key is written on every Symbol, carrying `null`
    // for "outside every Component". Symbol-to-Component attribution is not implemented,
    // so `null` is the honest value rather than a placeholder -- but omitting the key
    // would make this Symbol's shape differ from one that is attributed later.
    component: null,
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
    // Class A per ir-schema.md §1.1 -- see buildDroppedSymbol for why `null` is written
    // rather than the key omitted.
    component: null,
    visibility: input.candidate.visibility,
    // Sort every list-field by `.line` before it enters the IR. Integrity invariant
    // #11 (`checkArraySortOrder`) demands monotonic `.line` on `decorators` /
    // `rules` / `effects` / `calls` — but the upstream producers do NOT guarantee
    // that ordering on their own:
    //   - `decorators` from the language plugin land in AST traversal order, which
    //     tracks source order for stacked decorators but is not spelled out as a
    //     plugin contract.
    //   - `rules` come out of `walkBody` in visit order (branch tails after
    //     branch bodies, `else` before `try/finally`), so an integrity-safe
    //     ordering has to be applied here.
    //   - `effects` and `calls` were both re-sorted by `byTargetThenLine` in
    //     `classifyCalls` by `byTargetThenLine`. That satisfies human
    //     readability but violates monotonic `.line` the moment a Symbol has two
    //     entries whose target-alpha order is inverted from their source line.
    // A stable line sort here restores invariant #11 without disturbing the
    // relative order of same-line entries — same-line entries keep whatever
    // order the producer gave them (ir-schema.md §1: "ascending by `line`
    // (source order within the same line)").
    decorators: [...input.candidate.decorators].sort((a, b) => a.line - b.line),
    signature: input.candidate.signature,
    rules: [...input.rules].sort((a, b) => a.line - b.line),
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
