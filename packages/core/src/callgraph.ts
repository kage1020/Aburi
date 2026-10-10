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
import { DEFAULT_EXPORT_QNAME, trySymbolId } from "./id"
import { DEFAULT_EXPORT_NAME, splitAliasedImportName } from "./import-edge"
import type { ReceiverHint } from "./lsp/enrich"
import { emptyHintUsage, type LspConsumerRejection, type LspHintUsage } from "./lsp/stats"
import { compareCodeUnit } from "./order"

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
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>
  fileExtensions?: readonly string[]
  receiverHints?: ReadonlyMap<string, ReceiverHint>
  implementerHints?: ReadonlyMap<SymbolId, readonly SymbolId[]>
  dynamicCallSites?: ReadonlySet<string>
}

export interface ResolveCallGraphResult {
  symbols: IRSymbol[]
  edges: CallEdge[]
  stats: CallResolutionStats
  diagnostics: UnresolvedCallDiagnostic[]
  lspHintUsage: Readonly<LspHintUsage>
}

const DEFAULT_EXTENSIONS: readonly string[] = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]

export function resolveCallGraph(input: ResolveCallGraphInput): ResolveCallGraphResult {
  const extensions = input.fileExtensions ?? DEFAULT_EXTENSIONS
  const receiverHints = input.receiverHints ?? EMPTY_RECEIVER_HINTS
  assertReceiverHintKeys(receiverHints)
  const implementerHints = input.implementerHints ?? EMPTY_IMPLEMENTER_HINTS

  const keptSymbolIds = new Set<SymbolId>(input.symbols.filter((s) => !s.dropped).map((s) => s.id))
  const topLevelByFile = indexTopLevelByFile(input.symbols)
  const filesByLanguage = indexFilesByLanguage(input.symbols)
  const componentIndex = indexByComponent(input.symbols)
  const workspaceIndex = indexByWorkspace(input.symbols)
  const relativeTargets = new Map<string, string | null>()

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
          relativeTargets,
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

type LspHintOutcome =
  | { outcome: "hit"; hit: ResolutionHit }
  | { outcome: "absent" }
  | { outcome: "rejected"; reason: LspConsumerRejection }

const NO_HINT: LspHintOutcome = { outcome: "absent" }

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
 * parameter list today — `Symbol.signature.inputs[].name`, plus `inputs[].bindings`
 * for a destructuring parameter — so this helper captures the parameter subset of
 * the local-scope domain. Local variables and nested functions inside the body
 * are NOT visible in the IR yet; catching them fully requires the language plugin
 * to expose local declarations via a follow-up seam on `walkBody`. Guarding
 * parameters alone still eliminates the most common false-positive shape (a
 * Symbol name that coincides with a caller's parameter identifier).
 */
function collectParameterNames(symbol: IRSymbol): ReadonlySet<string> {
  const inputs = symbol.signature?.inputs
  if (inputs === undefined) return EMPTY_NAME_SET
  const out = new Set<string>()
  for (const input of inputs) {
    out.add(input.name)
    // A destructuring parameter's `name` is the pattern's text (`{ save }`), which no call
    // head can equal; the names it binds are listed beside it.
    if (input.bindings === undefined) continue
    for (const binding of input.bindings) out.add(binding)
  }
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
  /** `resolveRelativeSpecifier`'s answers for this run, filled by `resolveRelativeSpecifierOnce`. */
  relativeTargets: Map<string, string | null>
}

function resolveTarget(ctx: ResolveTargetContext, trace: ResolutionTrace): ResolutionHit | null {
  const segments = splitTargetSegments(ctx.target)
  if (segments.length === 0) {
    trace.unnamedReceiver = true
    return null
  }
  const head = segments[0] as string
  const tail = segments.slice(1)

  if (ctx.parameterNames.has(head)) {
    trace.parameterShadow = true
    return null
  }

  if (head === "this" || head === "super") {
    trace.unnamedReceiver = true
    return null
  }

  const fileHit = resolveInFileScope(ctx, head, tail, trace)
  if (fileHit !== null) return fileHit

  const importHit = resolveInImportScope(ctx, head, tail, trace)
  if (importHit !== null) return importHit

  if (tail.length === 0) return null

  const componentHit = resolveInComponentScope(ctx, trace)
  if (componentHit !== null) return componentHit

  const workspaceHit = resolveInWorkspaceScope(ctx, trace)
  if (workspaceHit !== null) return workspaceHit

  return null
}

function resolveInFileScope(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
  trace: ResolutionTrace,
): ResolutionHit | null {
  const perFile = ctx.topLevelByFile.get(ctx.caller.source.file)
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
  const id = memberId(ctx, ctx.caller.source.file, head, tail)
  return id === null ? null : { id, confidence: "high" }
}

function memberId(
  ctx: ResolveTargetContext,
  file: string,
  first: string,
  tail: readonly string[],
): SymbolId | null {
  const idOf = (qualifiedName: string) =>
    trySymbolId({ language: ctx.caller.language, file, qualifiedName })
  let qualifiedName = first
  for (const segment of tail) {
    const staticName = `${qualifiedName}::${segment}`
    const staticId = idOf(staticName)
    qualifiedName =
      staticId !== null && ctx.keptSymbolIds.has(staticId)
        ? staticName
        : `${qualifiedName}.${segment}`
  }
  const id = idOf(qualifiedName)
  return id !== null && ctx.keptSymbolIds.has(id) ? id : null
}

/**
 * Step 3 of call-resolution.md's untyped step order: consult `importTable[caller.file]`.
 * Named imports and aliased imports resolve the head directly, and a default import resolves
 * it to the module's default export; namespace imports (`import * as ns from './y'`) resolve
 * when the target reads `ns.member`.
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
  const candidates = new Set<SymbolId>()
  for (const edge of ctx.imports) {
    if (edge.dynamic) continue
    if (!isRelativeSpecifier(edge.source)) continue
    const targetFile = resolveRelativeSpecifierOnce(ctx, edge.source)
    if (targetFile === null) continue

    if (edge.symbols === "*") {
      const [first, ...rest] = tail
      if (first === undefined) continue
      if (edge.namespaceBinding !== head) continue
      const candidateId = memberId(ctx, targetFile, first, rest)
      if (candidateId !== null) candidates.add(candidateId)
      continue
    }

    for (const raw of edge.symbols) {
      const { imported, local } = splitAliasedImportName(raw)
      if (local !== head) continue
      // A default import (`"default as S"`) binds whatever the module exports as `default`,
      // under a name the importer chose, so the module is searched for its default export and
      // never for a Symbol called `S` (call-resolution.md §4.4, CR5–CR5d).
      if (imported === DEFAULT_EXPORT_NAME) {
        for (const exportedName of defaultExportsOf(ctx, targetFile)) {
          const candidateId = memberId(ctx, targetFile, exportedName, tail)
          if (candidateId !== null) candidates.add(candidateId)
        }
        continue
      }
      const candidateId = memberId(ctx, targetFile, imported, tail)
      if (candidateId !== null) candidates.add(candidateId)
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
 * The names of the top-level Symbols a file exports as `default`. The evidence is
 * `export-default` in `derivedBy`, which the TypeScript plugin puts on a named declaration
 * (`export default function makeApp`, and `const f = …; export default f`) and on its
 * anonymous `<default>` Symbol alike. The `<default>` name is accepted without the token as a
 * guard, not as a second case: `lang-plugin.md` LP6 asks a plugin for the name only, and one
 * that gives nothing more still reaches its anonymous default export (`call-resolution.md`
 * §4.4). More than one name is left to the caller's ambiguity check.
 */
function defaultExportsOf(ctx: ResolveTargetContext, file: string): string[] {
  const perName = ctx.topLevelByFile.get(file)
  if (perName === undefined) return []
  const found: string[] = []
  for (const bucket of perName.values()) {
    for (const symbol of bucket) {
      if (symbol.name === DEFAULT_EXPORT_QNAME || symbol.derivedBy.includes("export-default")) {
        found.push(symbol.name)
      }
    }
  }
  return found
}

/**
 * `resolveRelativeSpecifier` for the caller's file, answered once per run. Import scope asks
 * it for every import edge of every unresolved call, but the answer depends only on the
 * language, the caller's directory and the specifier (the probe list and the Symbol files are
 * fixed for the run), so a file with C unresolved calls and I imports asks it I times, not
 * C × I. Neither a language id nor a path can hold NUL and the specifier comes last, so the
 * key splits one way only, even for a specifier that decoded a `\0` (lang-plugin.md LP26k).
 */
function resolveRelativeSpecifierOnce(ctx: ResolveTargetContext, specifier: string): string | null {
  const callerFile = ctx.caller.source.file
  const key = `${ctx.caller.language}\0${dirname(callerFile)}\0${specifier}`
  const cached = ctx.relativeTargets.get(key)
  if (cached !== undefined) return cached
  const resolved = resolveRelativeSpecifier({
    callerFile,
    specifier,
    language: ctx.caller.language,
    extensions: ctx.extensions,
    filesByLanguage: ctx.filesByLanguage,
  })
  ctx.relativeTargets.set(key, resolved)
  return resolved
}

function recordAmbiguity(trace: ResolutionTrace, bucket: readonly IRSymbol[]): void {
  if (bucket.length < 2) return
  for (const symbol of bucket) trace.ambiguousCandidates.add(symbol.id)
}

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

function splitTargetSegments(target: string): string[] {
  if (target.length === 0) return []
  return target.split(".").filter((s) => s.length > 0)
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  )
}

const EMITTED_EXTENSION_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  ["js", ["ts", "tsx", "js", "jsx"]],
  ["jsx", ["tsx", "ts", "jsx", "js"]],
  ["mjs", ["mts", "mjs"]],
  ["cjs", ["cts", "cjs"]],
])

interface ResolveSpecifierInput {
  callerFile: string
  specifier: string
  language: string
  extensions: readonly string[]
  filesByLanguage: Map<string, Set<string>>
}

function resolveRelativeSpecifier(input: ResolveSpecifierInput): string | null {
  const known = input.filesByLanguage.get(input.language)
  if (known === undefined || known.size === 0) return null

  const callerDir = dirname(input.callerFile)
  const joined = joinPosix(callerDir, input.specifier)
  if (joined === null) return null

  const lastSegment = input.specifier.slice(input.specifier.lastIndexOf("/") + 1)
  const namesDirectory = lastSegment === "" || lastSegment === "." || lastSegment === ".."
  if (!namesDirectory) {
    for (const candidate of emittedExtensionSources(joined, input.extensions) ?? [joined]) {
      if (known.has(candidate)) return candidate
    }
    for (const ext of input.extensions) {
      const candidate = `${joined}.${ext}`
      if (known.has(candidate)) return candidate
    }
  }
  const indexStem = joined === "" ? "index" : `${joined}/index`
  for (const ext of input.extensions) {
    const candidate = `${indexStem}.${ext}`
    if (known.has(candidate)) return candidate
  }
  return null
}

function emittedExtensionSources(joined: string, extensions: readonly string[]): string[] | null {
  const dot = joined.lastIndexOf(".")
  if (dot <= joined.lastIndexOf("/") + 1) return null
  const written = joined.slice(dot + 1)
  const sources = EMITTED_EXTENSION_SOURCES.get(written)
  if (sources === undefined) return null
  const stem = joined.slice(0, dot)
  return sources
    .filter((ext) => ext === written || extensions.includes(ext))
    .map((ext) => `${stem}.${ext}`)
}

function dirname(posixPath: string): string {
  const idx = posixPath.lastIndexOf("/")
  if (idx < 0) return ""
  return posixPath.slice(0, idx)
}

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

function componentKeyOf(component: string | null): string {
  return component ?? ""
}

function compareCallEdge(a: CallEdge, b: CallEdge): number {
  return compareCodeUnit(a.from, b.from) || compareCodeUnit(a.to, b.to) || a.line - b.line
}
