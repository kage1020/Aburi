import type {
  CallResolutionStats,
  Confidence,
  ImportEdge,
  IR,
  Symbol as IRSymbol,
  SymbolId,
  UnresolvedCallBucket,
  UnresolvedCallBuckets,
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import { CALL_SITE_KEY_SEPARATOR, makeCallSiteKey, receiverHead } from "./call-site"
import { groupBy } from "./collections"
import { CoreError } from "./errors"
import { trySymbolId } from "./id"
import { splitAliasedImportName } from "./import-edge"
import type { ReceiverHint } from "./lsp/enrich"
import { emptyHintUsage, type LspConsumerRejection, type LspHintUsage } from "./lsp/stats"
import { compareCodeUnit } from "./order"

/**
 * Internal edge shape emitted by `resolveCallGraph`. Mirrors call-resolution.md;
 * see the doc for confidence semantics. This is NOT serialized to the IR — the caller
 * projects it into `Dependency` (ir-schema.md) after resolution.
 */
export interface CallEdge {
  from: SymbolId
  to: SymbolId
  via: "call"
  confidence: Confidence
  line: number
}

export interface ResolveCallGraphInput {
  /** Every Symbol produced by the scan, in any order. */
  symbols: readonly IRSymbol[]
  /**
   * Per-file `ImportEdge[]` keyed by the file's POSIX-relative path (must match
   * `Symbol.source.file`). Files with no imports may be absent from the map.
   */
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>
  /**
   * Extension probe order for relative import resolution. Defaults to
   * `["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]` — the standard
   * TypeScript / JavaScript set. The order matters: the first extension whose
   * candidate file appears in `symbols[]` wins.
   */
  fileExtensions?: readonly string[]
  /**
   * LSP-derived per-call-site hints (call-resolution.md). Keys are
   * `makeCallSiteKey(file, line, target)` — the same identity the hint producer
   * files them under, so a hint reaches the one call it was resolved for and no
   * other call sharing its line. Present only when the LSP enrichment pass ran;
   * consulted as the LSP tier before the resolver would otherwise return
   * `null`. Non-null `Call.resolved` values are still never overwritten.
   * A non-empty map keyed any other way raises `receiver-hint-key-malformed`
   * rather than missing every lookup in silence — see `assertReceiverHintKeys`.
   */
  receiverHints?: ReadonlyMap<string, ReceiverHint>
  /**
   * LSP-derived interface implementers, keyed by interface Symbol id and
   * lex-sorted so consumption order is deterministic. Used together
   * with `receiverHints` to promote a single-implementer interface call to a
   * `medium`-confidence edge.
   */
  implementerHints?: ReadonlyMap<SymbolId, readonly SymbolId[]>
  /**
   * Call sites whose receiver was an expression rather than a name, keyed by
   * `makeCallSiteKey`. Normalization collapses `getRepo().save()` to the target
   * `getRepo.save`, which reads exactly like a qualified name, so only the
   * language plugin can tell the two apart (`CallCandidate.dynamicReceiver`).
   * The set feeds diagnostics only — it never changes which calls resolve.
   */
  dynamicCallSites?: ReadonlySet<string>
}

export interface ResolveCallGraphResult {
  /**
   * Symbols with `calls[].resolved` filled in where the resolver produced a
   * non-null identity. Call entries otherwise keep their original ordering and
   * per-entry `target` / `line` values.
   */
  symbols: IRSymbol[]
  /**
   * Directed call edges, one per resolved call site. Multiple edges may share
   * the same `(from, to)` when the caller invokes the callee on more than one
   * line. Sorted by `(from, to, line)` ascending for byte-stability.
   */
  edges: CallEdge[]
  /**
   * Aggregate outcome counters for `IR.stats.callResolution`. Always populated,
   * so a workspace with zero call sites still reports the shape it observed.
   */
  stats: CallResolutionStats
  /**
   * One entry per call left `resolved: null`, sorted by
   * `(symbolId, line, target)` ascending. Not serialized into the IR — see
   * `UnresolvedCallDiagnostic`.
   */
  diagnostics: UnresolvedCallDiagnostic[]
  /**
   * What the LSP tier did with the hints it was handed — the consumer half of
   * `stats.lspEnrichment` (lsp-enrichment.md). All zero when no hints were
   * supplied. See `LspHintUsage` for why it comes back as a value; the caller
   * folds it into the producer half with `withHintUsage`.
   */
  lspHintUsage: Readonly<LspHintUsage>
}

const DEFAULT_EXTENSIONS: readonly string[] = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]

/**
 * Resolve every `Symbol.calls[]` entry against the workspace Symbol table using the
 * untyped resolution tiers from `call-resolution.md`: local shadow (parameter
 * subset), file scope, import scope, component scope, workspace scope. Each tier
 * is tried in order and the first hit wins; the confidence of the emitted edge
 * reflects the tier that produced it. A call the untyped tiers all miss gets one
 * last attempt at the LSP tier through `receiverHints` — see `resolveViaLspHint`
 * for why that attempt can only ever add an edge. Whatever still fails stays
 * `resolved: null`, exactly as the edge shape requires, and is bucketed into
 * `diagnostics`.
 *
 * Determinism: the resolver reads `symbols` and `importsByFile` and no filesystem
 * state, so the same inputs always produce the same outputs. Ambiguous matches
 * (two same-named top-level Symbols in the same file, two importable candidates
 * for the same specifier, two qname candidates in the same component, two globally
 * unique-name candidates) are conservatively left null — never silently picked —
 * so the caller never sees an edge that the resolver could not justify.
 */
export function resolveCallGraph(input: ResolveCallGraphInput): ResolveCallGraphResult {
  const extensions = input.fileExtensions ?? DEFAULT_EXTENSIONS
  const receiverHints = input.receiverHints ?? EMPTY_RECEIVER_HINTS
  assertReceiverHintKeys(receiverHints)
  const implementerHints = input.implementerHints ?? EMPTY_IMPLEMENTER_HINTS

  // Every downstream lookup uses `keptSymbolIds` (i.e. `dropped: false`) so
  // the resolver never fabricates an edge into a Symbol body that was dropped
  // by Category B/C rules. The body of a dropped Symbol is intentionally
  // empty and its fingerprints are zeroed — pretending calls target it would
  // mislead the reviewer.
  const keptSymbolIds = new Set<SymbolId>(input.symbols.filter((s) => !s.dropped).map((s) => s.id))
  const topLevelByFile = indexTopLevelByFile(input.symbols)
  const filesByLanguage = indexFilesByLanguage(input.symbols)
  const componentIndex = indexByComponent(input.symbols)
  const workspaceIndex = indexByWorkspace(input.symbols)

  const nextSymbols: IRSymbol[] = []
  const edges: CallEdge[] = []
  const diagnostics: UnresolvedCallDiagnostic[] = []
  const dynamicCallSites = input.dynamicCallSites ?? EMPTY_CALL_SITE_KEYS
  const lspHintUsage = emptyHintUsage()
  let totalCalls = 0
  let resolvedCalls = 0

  for (const symbol of input.symbols) {
    if (symbol.calls.length === 0) {
      nextSymbols.push(symbol)
      continue
    }
    totalCalls += symbol.calls.length
    const imports = input.importsByFile.get(symbol.source.file) ?? []
    const parameterNames = collectParameterNames(symbol)
    const updatedCalls = symbol.calls.map((call) => {
      if (call.resolved !== null) {
        resolvedCalls++
        return call
      }
      const trace = newTrace()
      const resolved = resolveTarget(
        {
          caller: symbol,
          target: call.target,
          imports,
          keptSymbolIds,
          topLevelByFile,
          filesByLanguage,
          componentIndex,
          workspaceIndex,
          extensions,
          parameterNames,
        },
        trace,
      )
      if (resolved !== null) {
        resolvedCalls++
        edges.push({
          from: symbol.id,
          to: resolved.id,
          via: "call",
          confidence: resolved.confidence,
          line: call.line,
        })
        return { target: call.target, line: call.line, resolved: resolved.id }
      }
      // Untyped tier missed — try LSP tier via receiverHints.
      const lspOutcome = resolveViaLspHint({
        caller: symbol,
        call,
        receiverHints,
        implementerHints,
        keptSymbolIds,
      })
      if (lspOutcome.outcome === "rejected") lspHintUsage[lspOutcome.reason] += 1
      const lspHit = lspOutcome.outcome === "hit" ? lspOutcome.hit : null
      if (lspHit === null) {
        diagnostics.push(
          classifyUnresolved({
            caller: symbol,
            target: call.target,
            line: call.line,
            imports,
            trace,
            dynamicReceiver: dynamicCallSites.has(
              makeCallSiteKey(symbol.source.file, call.line, call.target),
            ),
          }),
        )
        return call
      }
      resolvedCalls++
      lspHintUsage.consumed += 1
      edges.push({
        from: symbol.id,
        to: lspHit.id,
        via: "call",
        confidence: lspHit.confidence,
        line: call.line,
      })
      return { target: call.target, line: call.line, resolved: lspHit.id }
    })
    nextSymbols.push({ ...symbol, calls: updatedCalls })
  }

  edges.sort(compareCallEdge)
  diagnostics.sort(compareDiagnostic)
  return {
    symbols: nextSymbols,
    edges,
    stats: buildCallResolutionStats(totalCalls, resolvedCalls, diagnostics),
    diagnostics,
    lspHintUsage,
  }
}

const EMPTY_CALL_SITE_KEYS: ReadonlySet<string> = new Set()

/**
 * What the resolution attempt observed on its way to `null`. Populated as the
 * untyped tiers run so the miss can be bucketed afterwards without re-running
 * any of them — and without any tier changing the answer it already gave.
 */
interface ResolutionTrace {
  /** Candidates seen by a tier that found more than one match. */
  ambiguousCandidates: Set<SymbolId>
  /** Local scope — the callee identifier shadows a caller parameter. */
  parameterShadow: boolean
  /** Special normalized targets — `this` / `super`, or a target that carried no name at all. */
  unnamedReceiver: boolean
}

function newTrace(): ResolutionTrace {
  return { ambiguousCandidates: new Set(), parameterShadow: false, unnamedReceiver: false }
}

interface ClassifyUnresolvedInput {
  caller: IRSymbol
  target: string
  line: number
  imports: readonly ImportEdge[]
  trace: ResolutionTrace
  dynamicReceiver: boolean
}

/**
 * Bucket one unresolved call per `call-resolution.md`. The order below is
 * the tie-break: a call can satisfy several descriptions at once (a parameter
 * named after an imported package, say) and the reviewer needs one stable
 * answer, so the most specific cause wins.
 *
 *   1. `local-scope` — the resolver never even looked outward.
 *   2. `dynamic`     — the receiver is not a name, so no tier could have won.
 *   3. `ambiguous`   — a tier found the callee but refused to choose.
 *   4. `external`    — the binding leaves the workspace through a bare import.
 *   5. `no-match`    — nothing matched anywhere.
 */
function classifyUnresolved(input: ClassifyUnresolvedInput): UnresolvedCallDiagnostic {
  const base = {
    symbolId: input.caller.id,
    target: input.target,
    line: input.line,
  }
  if (input.trace.parameterShadow) {
    return { ...base, bucket: "local-scope", candidates: [] }
  }
  if (input.dynamicReceiver || input.trace.unnamedReceiver) {
    return { ...base, bucket: "dynamic", candidates: [] }
  }
  if (input.trace.ambiguousCandidates.size > 0) {
    return {
      ...base,
      bucket: "ambiguous",
      candidates: [...input.trace.ambiguousCandidates].sort(compareCodeUnit),
    }
  }
  if (bindsToExternalImport(input.target, input.imports)) {
    return { ...base, bucket: "external", candidates: [] }
  }
  return { ...base, bucket: "no-match", candidates: [] }
}

/**
 * True when the head of `target` is bound by an import whose specifier is not
 * relative — a bare package, a path alias, or a workspace package. Import specifier
 * resolution only resolves relative specifiers today, so such a head is out of reach by
 * construction rather than by accident, and calling it `no-match` would send a
 * reviewer looking for a typo that does not exist.
 */
function bindsToExternalImport(target: string, imports: readonly ImportEdge[]): boolean {
  const segments = splitTargetSegments(target)
  const head = segments[0]
  if (head === undefined) return false
  for (const edge of imports) {
    if (edge.dynamic) continue
    if (isRelativeSpecifier(edge.source)) continue
    if (edge.symbols === "*") {
      if (edge.namespaceBinding === head) return true
      continue
    }
    for (const raw of edge.symbols) {
      if (splitAliasedImportName(raw).local === head) return true
    }
  }
  return false
}

function buildCallResolutionStats(
  totalCalls: number,
  resolvedCalls: number,
  diagnostics: readonly UnresolvedCallDiagnostic[],
): CallResolutionStats {
  const unresolved: UnresolvedCallBuckets = {
    localScope: 0,
    external: 0,
    dynamic: 0,
    ambiguous: 0,
    noMatch: 0,
  }
  for (const diagnostic of diagnostics) {
    unresolved[BUCKET_TO_STATS_KEY[diagnostic.bucket]]++
  }
  return { totalCalls, resolvedCalls, unresolved }
}

/**
 * call-resolution.md spells the buckets kebab-case; the JSON Schema spells every property
 * camelCase. This table is the single place the two conventions meet.
 */
const BUCKET_TO_STATS_KEY: Record<UnresolvedCallBucket, keyof UnresolvedCallBuckets> = {
  "local-scope": "localScope",
  external: "external",
  dynamic: "dynamic",
  ambiguous: "ambiguous",
  "no-match": "noMatch",
}

function compareDiagnostic(a: UnresolvedCallDiagnostic, b: UnresolvedCallDiagnostic): number {
  return (
    compareCodeUnit(a.symbolId, b.symbolId) ||
    a.line - b.line ||
    compareCodeUnit(a.target, b.target)
  )
}

/**
 * Refuse a `receiverHints` map keyed by anything but `makeCallSiteKey`.
 *
 * Every other way this could go wrong announces itself: a hint for a call that
 * is not there is simply never read, a `kind` that disagrees is refused, a
 * dropped target falls through to the diagnostics. A map keyed the wrong way
 * announces nothing — every lookup misses, so the LSP tier contributes no edges
 * and the run is indistinguishable from one where the language server had
 * nothing to say. There is no counter for hints consumed, so nobody finds out.
 *
 * That failure is reachable by ordinary means: the keys were `${file}:${line}`
 * through @aburi/core 0.3.0, both spellings are `string`, and a caller who
 * upgrades keeps compiling. Better to name it once, at the entry, than to hand
 * back a graph that is quietly missing its typed tier.
 */
function assertReceiverHintKeys(hints: ReadonlyMap<string, ReceiverHint>): void {
  for (const key of hints.keys()) {
    if (key.includes(CALL_SITE_KEY_SEPARATOR)) continue
    throw new CoreError(
      `resolveCallGraph: receiverHints key ${JSON.stringify(key)} was not built by makeCallSiteKey(file, line, target)`,
      { code: "receiver-hint-key-malformed", value: key },
    )
  }
}

const EMPTY_RECEIVER_HINTS: ReadonlyMap<string, ReceiverHint> = new Map()
const EMPTY_IMPLEMENTER_HINTS: ReadonlyMap<SymbolId, readonly SymbolId[]> = new Map()

/**
 * Resolve a call left null by the untyped tier using LSP-derived hints (call-resolution.md).
 * `this.*` / `super.*` with a hint present resolve at `high` confidence — a known
 * simplification of confidence propagation, which rates an inherited hit `medium`:
 * `ReceiverHint` does not carry
 * how far the lookup travelled, so the two cases are indistinguishable here.
 *
 * A hint is looked up by the full call-site key and then checked against the call it would
 * resolve: `ReceiverHint.kind` must match `receiverHead(target)`, the producer's own
 * derivation. Neither check is redundant — the key stops a producer keyed to the line rather
 * than the call site (see `makeCallSiteKey` for the edge that fabricates), the `kind` check
 * stops a hand-built hint aimed at a target it does not describe. Neither can vouch for a hint
 * whose position was wrong, which is why `buildRequestJobs` declines that shape up front.
 *
 * Both refusals are reported rather than merely taken, so `resolveCallGraph` can count them
 * into `stats.lspEnrichment.hintsRejected` (lsp-enrichment.md); a hint the key never
 * reaches is the ordinary case, not a refusal. The order of the two checks is part of the
 * stats contract: a hint that fails both is counted as `kindMismatch` alone, so the same input
 * cannot be bucketed two ways (LE15).
 *
 * Two further invariants hold by the shape of the surrounding pass: an already-resolved call
 * is never overwritten (`resolveCallGraph` returns before reaching here, unconditionally,
 * even when the incoming `resolved` names no Symbol), and confidence only ever rises (LE16 —
 * the LSP tier fires solely where the untyped tier produced no edge). A hint whose target is
 * not in `keptSymbolIds` produces no edge, for the reason `keptSymbolIds` exists. Interface-tier
 * resolution is out of scope until the IR carries `implements` edges.
 */
function resolveViaLspHint(input: {
  caller: IRSymbol
  call: { target: string; line: number; resolved: SymbolId | null }
  receiverHints: ReadonlyMap<string, ReceiverHint>
  implementerHints: ReadonlyMap<SymbolId, readonly SymbolId[]>
  keptSymbolIds: ReadonlySet<SymbolId>
}): LspHintOutcome {
  const key = makeCallSiteKey(input.caller.source.file, input.call.line, input.call.target)
  const hint = input.receiverHints.get(key)
  if (hint === undefined) return NO_HINT
  if (receiverHead(input.call.target) !== hint.kind) {
    return { outcome: "rejected", reason: "kindMismatch" }
  }
  const target = hint.targetSymbolId
  if (!input.keptSymbolIds.has(target)) {
    return { outcome: "rejected", reason: "targetDropped" }
  }
  return { outcome: "hit", hit: { id: target, confidence: "high" } }
}

/**
 * What the LSP tier made of one call site: an edge, no hint at all, or a hint it
 * refused and the bucket that refusal belongs in. The third case is why this is
 * a variant rather than `ResolutionHit | null` — the caller has to tell "no hint
 * was offered" apart from "a hint was offered and declined", and only the second
 * is worth counting.
 */
type LspHintOutcome =
  | { outcome: "hit"; hit: ResolutionHit }
  | { outcome: "absent" }
  | { outcome: "rejected"; reason: LspConsumerRejection }

const NO_HINT: LspHintOutcome = { outcome: "absent" }

/**
 * Rebuild the resolved `CallEdge[]` for an already-scanned IR by walking every
 * Symbol's `calls[].resolved` field. `resolveCallGraph` runs at scan time and
 * writes its resolutions back into the IR, but the rich `CallEdge[]` array
 * itself is not serialised (only a collapsed `Dependency[]` projection lands in
 * `IR.dependencies`). Downstream passes — Slice View (docs/design/slice-view.md)
 * most notably — need the edges again after loading the IR from disk, and
 * reconstructing from `resolved` gives them the exact edge shape
 * `call-resolution.md` specifies (via = "call", per-call `line`, per-call
 * `confidence`). Unresolved calls (`resolved: null`) emit no edge — same rule
 * as at scan time.
 *
 * Confidence is inherited from the containing Symbol's own `confidence` field,
 * because the per-call confidence produced at scan time by `resolveCallGraph`
 * is not persisted (`ir-schema.md` does not model it on `Call`). This is a
 * conservative floor: a Symbol scanned with `high` confidence contributes edges
 * at `high`, while a `low`-confidence Symbol contributes `low` edges. Slice
 * View edge selection does not read `confidence`, so this floor is invisible in practice —
 * but it keeps the reconstructed edge shape structurally identical to what
 * `resolveCallGraph` returned, so future consumers that DO care about
 * confidence get a defensible answer.
 */
export function reconstructCallEdgesFromIR(ir: IR): CallEdge[] {
  const edges: CallEdge[] = []
  for (const symbol of ir.symbols) {
    if (symbol.calls.length === 0) continue
    for (const call of symbol.calls) {
      if (call.resolved === null) continue
      edges.push({
        from: symbol.id,
        to: call.resolved,
        via: "call",
        confidence: symbol.confidence,
        line: call.line,
      })
    }
  }
  edges.sort(compareCallEdge)
  return edges
}

/**
 * Step 1 of call-resolution.md's untyped step order requires the resolver to leave a call
 * unresolved when the callee identifier shadows a caller-local declaration
 * (parameter, local variable, or nested function). The IR only surfaces the
 * parameter list today — `Symbol.signature.inputs[].name` — so this helper
 * captures the parameter subset of the local-scope domain. Local variables and
 * nested functions inside the body are NOT visible in the IR yet; catching
 * them fully requires the language plugin to expose local declarations via a
 * follow-up seam on `walkBody`. Guarding parameters alone still eliminates
 * the most common false-positive shape (a Symbol name that coincides with a
 * caller's parameter identifier).
 */
function collectParameterNames(symbol: IRSymbol): ReadonlySet<string> {
  const inputs = symbol.signature?.inputs
  if (inputs === undefined) return EMPTY_NAME_SET
  const out = new Set<string>()
  for (const input of inputs) out.add(input.name)
  return out
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set()

interface ResolutionHit {
  id: SymbolId
  confidence: Confidence
}

interface ResolveTargetContext {
  caller: IRSymbol
  target: string
  imports: readonly ImportEdge[]
  keptSymbolIds: ReadonlySet<SymbolId>
  topLevelByFile: TopLevelIndex
  filesByLanguage: Map<string, Set<string>>
  componentIndex: ComponentIndex
  workspaceIndex: WorkspaceIndex
  extensions: readonly string[]
  parameterNames: ReadonlySet<string>
}

function resolveTarget(ctx: ResolveTargetContext, trace: ResolutionTrace): ResolutionHit | null {
  const segments = splitTargetSegments(ctx.target)
  if (segments.length === 0) {
    trace.unnamedReceiver = true
    return null
  }
  const head = segments[0] as string
  const tail = segments.slice(1)

  // Step 1: local scope shadows every outer binding. A caller parameter
  // named `helper` invoked as `helper(...)` — or as `helper.method(...)` —
  // is a runtime value, not a Symbol reference, so the correct outcome is a
  // null resolution and no edge.
  if (ctx.parameterNames.has(head)) {
    trace.parameterShadow = true
    return null
  }

  // Special normalized targets: `this.<method>` / `super.<method>` MUST
  // stay unresolved in the untyped tier because the receiver identity depends
  // on the caller's class hierarchy, which only the LSP tier can see. Even if
  // a Symbol whose `name` happens to be `this.method` appeared in the table,
  // it would not be a legitimate call target — never fabricate a name for a
  // receiver that isn't a name.
  if (head === "this" || head === "super") {
    trace.unnamedReceiver = true
    return null
  }

  const fileHit = resolveInFileScope(
    ctx.caller,
    head,
    tail,
    ctx.keptSymbolIds,
    ctx.topLevelByFile,
    trace,
  )
  if (fileHit !== null) return fileHit

  const importHit = resolveInImportScope(ctx, head, tail, trace)
  if (importHit !== null) return importHit

  // Component / workspace scope only apply to qualified names ("Cls.method",
  // "Namespace.Cls.method"). A single identifier that missed file / import scope is
  // either a local, an external, or a genuine miss — resolving it via
  // workspace search would just produce weak-evidence edges to unrelated
  // Symbols that happen to share the name.
  if (tail.length === 0) return null

  const componentHit = resolveInComponentScope(ctx, trace)
  if (componentHit !== null) return componentHit

  const workspaceHit = resolveInWorkspaceScope(ctx, trace)
  if (workspaceHit !== null) return workspaceHit

  return null
}

/**
 * Step 2 of call-resolution.md's untyped step order: resolve `head` against the top-level
 * Symbols declared in the caller's own file. For a dotted target the head must match a
 * class-shaped top-level Symbol and the joined `head.tail` qname must itself exist as a
 * Symbol id in the same file.
 */
function resolveInFileScope(
  caller: IRSymbol,
  head: string,
  tail: readonly string[],
  keptSymbolIds: ReadonlySet<SymbolId>,
  topLevelByFile: TopLevelIndex,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const perFile = topLevelByFile.get(caller.source.file)
  if (perFile === undefined) return null
  const bucket = perFile.get(head)
  if (bucket === undefined) return null
  if (bucket.length !== 1) {
    recordAmbiguity(trace, bucket)
    return null
  }
  const anchor = bucket[0] as IRSymbol

  if (tail.length === 0) {
    return { id: anchor.id, confidence: "high" }
  }
  const compositeId = trySymbolId({
    language: caller.language,
    file: caller.source.file,
    qualifiedName: `${head}.${tail.join(".")}`,
  })
  if (compositeId !== null && keptSymbolIds.has(compositeId)) {
    return { id: compositeId, confidence: "high" }
  }
  return null
}

/**
 * Step 3 of call-resolution.md's untyped step order: consult `importTable[caller.file]`.
 * Named imports and aliased imports resolve the head directly; namespace imports
 * (`import * as ns from './y'`) resolve when the target reads `ns.member`.
 * Import specifier resolution is limited to relative paths in this pass (step 1 of
 * call-resolution.md's import-specifier resolution); path aliases and workspace-package
 * specifiers are the concern of the follow-up implementation.
 */
function resolveInImportScope(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
  trace: ResolutionTrace,
): ResolutionHit | null {
  // Collect every candidate id that the imports of this file could bind `head`
  // to. Multiple hits (re-export barrel forwarding the same name from two
  // sources, generated code, ...) is an ambiguity — call-resolution.md requires the
  // resolver to yield null rather than silently picking the first one.
  const candidates = new Set<SymbolId>()
  for (const edge of ctx.imports) {
    if (edge.dynamic) continue
    if (!isRelativeSpecifier(edge.source)) continue
    const targetFile = resolveRelativeSpecifier({
      callerFile: ctx.caller.source.file,
      specifier: edge.source,
      language: ctx.caller.language,
      extensions: ctx.extensions,
      filesByLanguage: ctx.filesByLanguage,
    })
    if (targetFile === null) continue

    if (edge.symbols === "*") {
      if (tail.length === 0) continue
      if (edge.namespaceBinding !== head) continue
      const candidateId = trySymbolId({
        language: ctx.caller.language,
        file: targetFile,
        qualifiedName: tail.join("."),
      })
      if (candidateId !== null && ctx.keptSymbolIds.has(candidateId)) candidates.add(candidateId)
      continue
    }

    for (const raw of edge.symbols) {
      const { imported, local } = splitAliasedImportName(raw)
      if (local !== head) continue
      const candidateId = trySymbolId({
        language: ctx.caller.language,
        file: targetFile,
        qualifiedName: tail.length === 0 ? imported : `${imported}.${tail.join(".")}`,
      })
      if (candidateId !== null && ctx.keptSymbolIds.has(candidateId)) candidates.add(candidateId)
    }
  }
  if (candidates.size !== 1) {
    if (candidates.size > 1) for (const id of candidates) trace.ambiguousCandidates.add(id)
    return null
  }
  const [only] = candidates
  if (only === undefined) return null
  return { id: only, confidence: "high" }
}

/**
 * Record the competing Symbols a tier refused to choose between. Only genuine
 * ambiguity (two or more) counts — a single-entry bucket that failed a later
 * check is a miss, not a conflict.
 */
function recordAmbiguity(trace: ResolutionTrace, bucket: readonly IRSymbol[]): void {
  if (bucket.length < 2) return
  for (const symbol of bucket) trace.ambiguousCandidates.add(symbol.id)
}

/**
 * Step 4 of call-resolution.md's untyped step order: if steps 1–3 miss and `target` is a
 * qualified name, search Symbols within the caller's component whose `name`
 * equals `target`. Unique match → medium confidence; ambiguous → null. The cross-language
 * filter is enforced by `ComponentIndex`'s own outer language key, so cross-language buckets
 * never share a `(component, name)` cell.
 * Component-scope search ignores `import` bindings — that is the whole point
 * of component scope (barrel re-exports, inheritance-style references).
 */
function resolveInComponentScope(
  ctx: ResolveTargetContext,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const perLang = ctx.componentIndex.get(ctx.caller.language)
  if (perLang === undefined) return null
  const componentKey = componentKeyOf(ctx.caller.component ?? null)
  const perComponent = perLang.get(componentKey)
  if (perComponent === undefined) return null
  const bucket = perComponent.get(ctx.target)
  if (bucket === undefined) return null
  if (bucket.length !== 1) {
    recordAmbiguity(trace, bucket)
    return null
  }
  const hit = bucket[0] as IRSymbol
  if (!ctx.keptSymbolIds.has(hit.id)) return null
  return { id: hit.id, confidence: "medium" }
}

/**
 * Step 5 of call-resolution.md's untyped step order: same as component scope but
 * workspace-wide within a single language (cross-language edges are not emitted by the
 * untyped tier). Unique match → low confidence; ambiguous → null; no match → null.
 */
function resolveInWorkspaceScope(
  ctx: ResolveTargetContext,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const perLang = ctx.workspaceIndex.get(ctx.caller.language)
  if (perLang === undefined) return null
  const bucket = perLang.get(ctx.target)
  if (bucket === undefined) return null
  if (bucket.length !== 1) {
    recordAmbiguity(trace, bucket)
    return null
  }
  const hit = bucket[0] as IRSymbol
  if (!ctx.keptSymbolIds.has(hit.id)) return null
  return { id: hit.id, confidence: "low" }
}

/**
 * Split a normalized callee target (`"foo"`, `"foo.bar"`, `"Cls.method"`) into
 * dotted segments. Empty segments — the ones a leading/trailing dot would
 * produce — are dropped so a malformed target still yields something safe to
 * probe against the Symbol table.
 */
function splitTargetSegments(target: string): string[] {
  if (target.length === 0) return []
  return target.split(".").filter((s) => s.length > 0)
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

interface ResolveSpecifierInput {
  callerFile: string
  specifier: string
  language: string
  extensions: readonly string[]
  filesByLanguage: Map<string, Set<string>>
}

/**
 * Resolve `./y` / `../y` against the caller file's directory, then probe
 * candidate extensions until one lands on a file that actually declares any
 * Symbol. Directory targets probe `<path>/index.<ext>` per call-resolution.md
 * import specifier resolution, step 3.
 */
function resolveRelativeSpecifier(input: ResolveSpecifierInput): string | null {
  const known = input.filesByLanguage.get(input.language)
  if (known === undefined || known.size === 0) return null

  const callerDir = dirname(input.callerFile)
  const joined = joinPosix(callerDir, input.specifier)
  if (joined === null) return null

  if (known.has(joined)) return joined
  for (const ext of input.extensions) {
    const candidate = `${joined}.${ext}`
    if (known.has(candidate)) return candidate
  }
  for (const ext of input.extensions) {
    const candidate = `${joined}/index.${ext}`
    if (known.has(candidate)) return candidate
  }
  return null
}

function dirname(posixPath: string): string {
  const idx = posixPath.lastIndexOf("/")
  if (idx < 0) return ""
  return posixPath.slice(0, idx)
}

/**
 * Join a POSIX directory with a `./` / `../` specifier, collapsing `.` and `..`
 * segments. Returns null when `..` climbs above the workspace root — those
 * specifiers cannot map to a workspace file and must not be silently clamped.
 */
function joinPosix(base: string, specifier: string): string | null {
  const baseSegments = base === "" ? [] : base.split("/")
  const relSegments = specifier.split("/")
  const stack: string[] = [...baseSegments]
  for (const seg of relSegments) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join("/")
}

type TopLevelIndex = Map<string, Map<string, IRSymbol[]>>

/**
 * Build `Map<file, Map<top-level-name, Symbol[]>>`. Only genuine top-level
 * Symbols (whose `Symbol.name` has no `.` — no member accessor) participate.
 * Method-level Symbols (`Cls.method`) are already reachable through the
 * separate `symbolIds` set for the dotted-target composite id lookup, so
 * indexing them here would spuriously inflate the ambiguity check that guards
 * `bucket.length !== 1`. Dropped Symbols are skipped: their bodies are empty
 * and their fingerprints are zeroed, so fabricating an edge into a dropped
 * body would be misleading downstream.
 */
function indexTopLevelByFile(symbols: readonly IRSymbol[]): TopLevelIndex {
  const topLevel = symbols.filter((symbol) => !symbol.dropped && !symbol.name.includes("."))
  return mapValues(
    groupBy(topLevel, (symbol) => symbol.source.file),
    (perFile) => groupBy(perFile, (symbol) => symbol.name),
  )
}

function indexFilesByLanguage(symbols: readonly IRSymbol[]): Map<string, Set<string>> {
  return mapValues(
    groupBy(symbols, (symbol) => symbol.language),
    (perLang) => new Set(perLang.map((symbol) => symbol.source.file)),
  )
}

/**
 * `language → componentKey → Symbol.name → Symbol[]`. Used by component scope to search
 * for a qualified name within the caller's component boundary. `componentKey`
 * folds `null`/`undefined` into a single "no component" bucket (see
 * `componentKeyOf`) so callers with `component: null` still resolve against
 * peers that also have `component: null`. Dropped Symbols are skipped — they
 * are never valid callees. The final list is left in the original input order;
 * `resolveInComponentScope` treats a `length !== 1` bucket as ambiguous, so no
 * tiebreak is needed to keep the result deterministic.
 */
type ComponentIndex = Map<string, Map<string, Map<string, IRSymbol[]>>>

function indexByComponent(symbols: readonly IRSymbol[]): ComponentIndex {
  const kept = symbols.filter((symbol) => !symbol.dropped)
  return mapValues(
    groupBy(kept, (symbol) => symbol.language),
    (perLang) =>
      mapValues(
        groupBy(perLang, (symbol) => componentKeyOf(symbol.component ?? null)),
        (perComponent) => groupBy(perComponent, (symbol) => symbol.name),
      ),
  )
}

/**
 * `language → Symbol.name → Symbol[]`. Used by workspace scope to search the whole
 * workspace within a single language. Cross-language matches are prevented by
 * the outer language key — call-resolution.md defers cross-language
 * resolution to a follow-up phase. Dropped Symbols are skipped for the same
 * reason as in `indexByComponent`.
 */
type WorkspaceIndex = Map<string, Map<string, IRSymbol[]>>

function indexByWorkspace(symbols: readonly IRSymbol[]): WorkspaceIndex {
  const kept = symbols.filter((symbol) => !symbol.dropped)
  return mapValues(
    groupBy(kept, (symbol) => symbol.language),
    (perLang) => groupBy(perLang, (symbol) => symbol.name),
  )
}

/** `map` with every value replaced by `transform(value)`, keys and order kept. */
function mapValues<K, V, W>(map: ReadonlyMap<K, V>, transform: (value: V) => W): Map<K, W> {
  return new Map([...map].map(([key, value]) => [key, transform(value)]))
}

/**
 * Fold `Symbol.component` (`ComponentId | null | undefined`) into a stable
 * string key. An empty-string key represents "no component" and can never
 * collide with a real component id (which per `ir-schema.md` is required to be
 * ASCII kebab-case — non-empty).
 */
function componentKeyOf(component: string | null): string {
  return component ?? ""
}

function compareCallEdge(a: CallEdge, b: CallEdge): number {
  return compareCodeUnit(a.from, b.from) || compareCodeUnit(a.to, b.to) || a.line - b.line
}
