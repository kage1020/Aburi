import type { Confidence, ImportEdge, Symbol as IRSymbol, SymbolId } from "@aburi/types"

/**
 * Internal edge shape emitted by `resolveCallGraph`. Mirrors call-resolution.md §7.1;
 * see the doc for confidence semantics. This is NOT serialized to the IR — the caller
 * projects it into `Dependency` (ir-schema.md §11) after resolution.
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
}

const DEFAULT_EXTENSIONS: readonly string[] = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]

/**
 * Resolve every `Symbol.calls[]` entry against the workspace Symbol table using the
 * untyped resolution tiers from `call-resolution.md`: §4.2 local shadow (parameter
 * subset), §4.3 file scope, §4.4 import scope, §4.5 component scope, §4.6 workspace
 * scope. Each tier is tried in order and the first hit wins; the confidence of the
 * emitted edge reflects the tier that produced it (§7.2). The LSP-enriched tier
 * (§5) is intentionally deferred to a follow-up implementation; unresolved calls
 * stay `resolved: null`, exactly as §7.1 requires.
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

  for (const symbol of input.symbols) {
    if (symbol.calls.length === 0) {
      nextSymbols.push(symbol)
      continue
    }
    const imports = input.importsByFile.get(symbol.source.file) ?? []
    const parameterNames = collectParameterNames(symbol)
    const updatedCalls = symbol.calls.map((call) => {
      if (call.resolved !== null) return call
      const resolved = resolveTarget({
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
      })
      if (resolved === null) return call
      edges.push({
        from: symbol.id,
        to: resolved.id,
        via: "call",
        confidence: resolved.confidence,
        line: call.line,
      })
      return { target: call.target, line: call.line, resolved: resolved.id }
    })
    nextSymbols.push({ ...symbol, calls: updatedCalls })
  }

  edges.sort(compareCallEdge)
  return { symbols: nextSymbols, edges }
}

/**
 * Step 1 (call-resolution.md §4.2) requires the resolver to leave a call
 * unresolved when the callee identifier shadows a caller-local declaration
 * (parameter, local variable, or nested function). The IR only surfaces the
 * parameter list today — `Symbol.signature.inputs[].name` — so this helper
 * captures the parameter subset of the §4.2 domain. Local variables and
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

function resolveTarget(ctx: ResolveTargetContext): ResolutionHit | null {
  const segments = splitTargetSegments(ctx.target)
  if (segments.length === 0) return null
  const head = segments[0] as string
  const tail = segments.slice(1)

  // §4.2 Step 1: local scope shadows every outer binding. A caller parameter
  // named `helper` invoked as `helper(...)` — or as `helper.method(...)` —
  // is a runtime value, not a Symbol reference, so the correct outcome is a
  // null resolution and no edge.
  if (ctx.parameterNames.has(head)) return null

  // §4.7 Special normalized targets: `this.<method>` / `super.<method>` MUST
  // stay unresolved in the untyped tier because the receiver identity depends
  // on the caller's class hierarchy, which only the LSP tier can see. Even if
  // a Symbol whose `name` happens to be `this.method` appeared in the table,
  // it would not be a legitimate call target — never fabricate a name for a
  // receiver that isn't a name.
  if (head === "this" || head === "super") return null

  const fileHit = resolveInFileScope(ctx.caller, head, tail, ctx.keptSymbolIds, ctx.topLevelByFile)
  if (fileHit !== null) return fileHit

  const importHit = resolveInImportScope(ctx, head, tail)
  if (importHit !== null) return importHit

  // §4.5 / §4.6 only apply to qualified names ("Cls.method",
  // "Namespace.Cls.method"). A single identifier that missed §4.3 / §4.4 is
  // either a local, an external, or a genuine miss — resolving it via
  // workspace search would just produce weak-evidence edges to unrelated
  // Symbols that happen to share the name.
  if (tail.length === 0) return null

  const componentHit = resolveInComponentScope(ctx)
  if (componentHit !== null) return componentHit

  const workspaceHit = resolveInWorkspaceScope(ctx)
  if (workspaceHit !== null) return workspaceHit

  return null
}

/**
 * Step 2 (call-resolution.md §4.3): resolve `head` against the top-level Symbols
 * declared in the caller's own file. For a dotted target the head must match a
 * class-shaped top-level Symbol and the joined `head.tail` qname must itself
 * exist as a Symbol id in the same file.
 */
function resolveInFileScope(
  caller: IRSymbol,
  head: string,
  tail: readonly string[],
  keptSymbolIds: ReadonlySet<SymbolId>,
  topLevelByFile: TopLevelIndex,
): ResolutionHit | null {
  const perFile = topLevelByFile.get(caller.source.file)
  if (perFile === undefined) return null
  const bucket = perFile.get(head)
  if (bucket === undefined) return null
  if (bucket.length !== 1) return null
  const anchor = bucket[0] as IRSymbol

  if (tail.length === 0) {
    return { id: anchor.id, confidence: "high" }
  }
  const compositeQname = `${head}.${tail.join(".")}`
  const compositeId: SymbolId = `${caller.language}:${caller.source.file}#${compositeQname}`
  if (keptSymbolIds.has(compositeId)) {
    return { id: compositeId, confidence: "high" }
  }
  return null
}

/**
 * Step 3 (call-resolution.md §4.4): consult `importTable[caller.file]`. Named
 * imports and aliased imports resolve the head directly; namespace imports
 * (`import * as ns from './y'`) resolve when the target reads `ns.member`.
 * Import specifier resolution is limited to relative paths in this pass
 * (call-resolution.md §4.4.1 step 1); path aliases and workspace-package
 * specifiers are the concern of the follow-up implementation.
 */
function resolveInImportScope(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
): ResolutionHit | null {
  // Collect every candidate id that the imports of this file could bind `head`
  // to. Multiple hits (re-export barrel forwarding the same name from two
  // sources, generated code, ...) is an ambiguity — §7.1 requires the
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
      const qname = tail.join(".")
      const candidateId: SymbolId = `${ctx.caller.language}:${targetFile}#${qname}`
      if (ctx.keptSymbolIds.has(candidateId)) candidates.add(candidateId)
      continue
    }

    for (const raw of edge.symbols) {
      const { imported, local } = splitAliasedImportName(raw)
      if (local !== head) continue
      const qname = tail.length === 0 ? imported : `${imported}.${tail.join(".")}`
      const candidateId: SymbolId = `${ctx.caller.language}:${targetFile}#${qname}`
      if (ctx.keptSymbolIds.has(candidateId)) candidates.add(candidateId)
    }
  }
  if (candidates.size !== 1) return null
  const [only] = candidates
  return { id: only as SymbolId, confidence: "high" }
}

/**
 * Step 4 (call-resolution.md §4.5): if steps 1–3 miss and `target` is a
 * qualified name, search Symbols within the caller's component whose `name`
 * equals `target`. Unique match → medium confidence; ambiguous → null. The
 * language filter (§7.3) is enforced by `ComponentIndex`'s own outer language
 * key, so cross-language buckets never share a `(component, name)` cell.
 * Component-scope search ignores `import` bindings — that is the whole point
 * of §4.5 (barrel re-exports, inheritance-style references).
 */
function resolveInComponentScope(ctx: ResolveTargetContext): ResolutionHit | null {
  const perLang = ctx.componentIndex.get(ctx.caller.language)
  if (perLang === undefined) return null
  const componentKey = componentKeyOf(ctx.caller.component ?? null)
  const perComponent = perLang.get(componentKey)
  if (perComponent === undefined) return null
  const bucket = perComponent.get(ctx.target)
  if (bucket === undefined || bucket.length !== 1) return null
  const hit = bucket[0] as IRSymbol
  if (!ctx.keptSymbolIds.has(hit.id)) return null
  return { id: hit.id, confidence: "medium" }
}

/**
 * Step 5 (call-resolution.md §4.6): same as §4.5 but workspace-wide within a
 * single language (§7.3 — cross-language edges are not emitted by the untyped
 * tier). Unique match → low confidence; ambiguous → null; no match → null.
 */
function resolveInWorkspaceScope(ctx: ResolveTargetContext): ResolutionHit | null {
  const perLang = ctx.workspaceIndex.get(ctx.caller.language)
  if (perLang === undefined) return null
  const bucket = perLang.get(ctx.target)
  if (bucket === undefined || bucket.length !== 1) return null
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

/**
 * Handle the `import { X as Alias } from './y'` form. The language plugin emits
 * the raw string as it appeared in source (`"X as Alias"` or `"X"`), so recover
 * both names here. `imported` is the exported name in the source module,
 * `local` is what the caller writes at the call site.
 */
function splitAliasedImportName(raw: string): { imported: string; local: string } {
  const marker = " as "
  const idx = raw.indexOf(marker)
  if (idx < 0) return { imported: raw, local: raw }
  const imported = raw.slice(0, idx).trim()
  const local = raw.slice(idx + marker.length).trim()
  return { imported, local }
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
 * §4.4.1 step 3.
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
  const out: TopLevelIndex = new Map()
  for (const symbol of symbols) {
    if (symbol.dropped) continue
    if (symbol.name.includes(".")) continue
    const perFile = out.get(symbol.source.file) ?? new Map<string, IRSymbol[]>()
    const bucket = perFile.get(symbol.name) ?? []
    bucket.push(symbol)
    perFile.set(symbol.name, bucket)
    out.set(symbol.source.file, perFile)
  }
  return out
}

function indexFilesByLanguage(symbols: readonly IRSymbol[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const symbol of symbols) {
    const bucket = out.get(symbol.language) ?? new Set<string>()
    bucket.add(symbol.source.file)
    out.set(symbol.language, bucket)
  }
  return out
}

/**
 * `language → componentKey → Symbol.name → Symbol[]`. Used by §4.5 to search
 * for a qualified name within the caller's component boundary. `componentKey`
 * folds `null`/`undefined` into a single "no component" bucket (see
 * `componentKeyOf`) so callers with `component: null` still resolve against
 * peers that also have `component: null`. Dropped Symbols are skipped — they
 * are never valid callees. The final list is left in the original input order;
 * `resolveInComponentScope` treats a `length !== 1` bucket as ambiguous, so no
 * tiebreak is needed to keep the result deterministic (§9).
 */
type ComponentIndex = Map<string, Map<string, Map<string, IRSymbol[]>>>

function indexByComponent(symbols: readonly IRSymbol[]): ComponentIndex {
  const out: ComponentIndex = new Map()
  for (const symbol of symbols) {
    if (symbol.dropped) continue
    const perLang = out.get(symbol.language) ?? new Map<string, Map<string, IRSymbol[]>>()
    const componentKey = componentKeyOf(symbol.component ?? null)
    const perComponent = perLang.get(componentKey) ?? new Map<string, IRSymbol[]>()
    const bucket = perComponent.get(symbol.name) ?? []
    bucket.push(symbol)
    perComponent.set(symbol.name, bucket)
    perLang.set(componentKey, perComponent)
    out.set(symbol.language, perLang)
  }
  return out
}

/**
 * `language → Symbol.name → Symbol[]`. Used by §4.6 to search the whole
 * workspace within a single language. Cross-language matches are prevented by
 * the outer language key — call-resolution.md §7.3 defers cross-language
 * resolution to a follow-up phase. Dropped Symbols are skipped for the same
 * reason as in `indexByComponent`.
 */
type WorkspaceIndex = Map<string, Map<string, IRSymbol[]>>

function indexByWorkspace(symbols: readonly IRSymbol[]): WorkspaceIndex {
  const out: WorkspaceIndex = new Map()
  for (const symbol of symbols) {
    if (symbol.dropped) continue
    const perLang = out.get(symbol.language) ?? new Map<string, IRSymbol[]>()
    const bucket = perLang.get(symbol.name) ?? []
    bucket.push(symbol)
    perLang.set(symbol.name, bucket)
    out.set(symbol.language, perLang)
  }
  return out
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
  if (a.from < b.from) return -1
  if (a.from > b.from) return 1
  if (a.to < b.to) return -1
  if (a.to > b.to) return 1
  return a.line - b.line
}
