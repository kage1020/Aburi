import type { DependencyEndpoint, IR, Symbol as IRSymbol } from "@aburi/types"
import { CoreError, type IntegrityViolation } from "./errors"
import { isComponentId, isLanguageId, isSymbolId, RESERVED_LANGUAGE_IDS } from "./id"

/**
 * Core effect vocabulary frozen by aburi.ir.v1. The set is append-only across patch
 * releases and never modified or removed; plugin-specific effects use the `x-<plugin>:`
 * prefix and bypass this list entirely. Mirrors ir-schema.md §9.1 — kept here as a literal
 * because the schema only encodes the regex shape, not the closed enumeration.
 */
const CORE_EFFECT_VOCAB: ReadonlySet<string> = new Set([
  "db.read",
  "db.write",
  "db.transaction",
  "db.migration",
  "network.http",
  "network.ws",
  "network.rpc",
  "queue.publish",
  "queue.consume",
  "event.publish",
  "event.subscribe",
  "fs.read",
  "fs.write",
  "state.mutate",
  "collection.mutate",
  "time.now",
  "time.timer",
  "random",
  "env.read",
  "env.write",
  "process.exit",
  "process.signal",
])

/** Symbol.kind core enumeration (ir-schema.md §5.1). */
const CORE_KIND_ENUM: ReadonlySet<string> = new Set([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "const",
  "module",
  "namespace",
  "variable",
  "enum",
  "constructor",
  "call",
])

/** Symbol.confidence enumeration (ir-schema.md §5.4). */
const CORE_CONFIDENCE_ENUM: ReadonlySet<string> = new Set(["high", "medium", "low"])

/** Plugin-extension effect prefix: `x-<plugin>:<action>`. */
const PLUGIN_EFFECT_PATTERN = /^x-[a-z][a-z0-9-]*:[a-z][a-z0-9.-]+$/

/** `<namespace>(:<segment>)+`, at least two segments, lowercase ASCII. */
const EXT_KIND_PATTERN = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9.-]*)+$/

/** Symbol id shape: `<language>:<file-path>#<qualified-name>`. */
const SYMBOL_ID_PATTERN = /^[a-z][a-z0-9]*:[^#]+#.+$/

/**
 * Run every invariant ir-schema.md §14 enumerates. Returns the violations array (possibly
 * empty); callers that want the throwing form use `assertIRIntegrity`.
 *
 * The 18 invariants checked here are:
 *   1. Symbol id uniqueness
 *   2. Component id uniqueness
 *   3. Symbol.component → Components[].id existence
 *   4. Dependency endpoints that look like Symbol ids exist in Symbols[]
 *   5. dropped=true ⇒ dropReason non-null
 *   6. Symbol.confidence ∈ enum
 *   7. Effect.id ∈ core vocab OR x-<plugin>: prefix
 *   8. Symbol.kind ∈ enum
 *   9. Symbol.extKind null or matches namespace:segment+ pattern
 *  10. All file paths POSIX (forward slash, no backslash, no absolute prefix)
 *  11. Arrays are sorted per the IR schema's ordering rules
 *  12. via:"call" edges: both endpoints are Symbol ids present in Symbols[]
 *  13. dependencies[]: no duplicate (from, to, via) triples
 *  14. Symbol.calls[].resolved and via:"call" edges agree (call-graph projection is total)
 *  15. stats.callResolution (when present) is a faithful census of Symbol.calls[]
 *  16. No Symbol id or Dependency endpoint uses a reserved language token (today: `slice`)
 *  17. Symbol and Component ids satisfy their own grammars
 *  18. workspace.languages is non-empty, well-formed, and covers every Symbol.language
 */
export function checkIRIntegrity(ir: IR): IntegrityViolation[] {
  const violations: IntegrityViolation[] = []

  checkSymbolIdUniqueness(ir, violations)
  checkComponentIdUniqueness(ir, violations)
  checkSymbolComponentRef(ir, violations)
  checkDependencyEndpoints(ir, violations)
  checkDroppedSymbolHasReason(ir, violations)
  checkSymbolConfidenceEnum(ir, violations)
  checkEffectVocab(ir, violations)
  checkSymbolKindEnum(ir, violations)
  checkSymbolExtKindShape(ir, violations)
  checkPathsArePosix(ir, violations)
  checkArraySortOrder(ir, violations)
  checkCallEdgeEndpoints(ir, violations)
  checkDependencyTupleUniqueness(ir, violations)
  checkCallGraphProjectionAgrees(ir, violations)
  checkCallResolutionStatsCensus(ir, violations)
  checkSymbolIdNamespace(ir, violations)
  checkIdGrammar(ir, violations)
  checkWorkspaceLanguages(ir, violations)

  return violations
}

/** Throwing variant: same checks, aggregates every violation into one CoreError. */
export function assertIRIntegrity(ir: IR): void {
  const violations = checkIRIntegrity(ir)
  if (violations.length === 0) return
  const summary = violations.map((v) => `[#${v.invariant}] ${v.subject}: ${v.message}`).join("; ")
  throw new CoreError(`IR integrity check failed (${violations.length}): ${summary}`, {
    code: "integrity-violation",
    violations,
  })
}

/**
 * Invariant #16 (ir-schema.md §14, §3.5): no Symbol id and no Dependency endpoint uses a
 * language token reserved to a different id namespace.
 *
 * `makeSymbolId` already refuses these, so a document Aburi produced cannot break this. The
 * check is here for the ones it did not produce — an IR read off disk, or written by an
 * older or third-party generator. A `slice:`-prefixed Symbol id would be indistinguishable
 * from a Slice id, and the Slice View pass would derive `slice:slice:…` from it.
 */
function checkSymbolIdNamespace(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    reportReservedNamespace(symbol.id, symbol.id, out)
  }
  // Endpoints too, not just `symbols[]`. A `slice:`-namespaced endpoint would otherwise be
  // reported by #4 as a Symbol id with no matching Symbol — detected, but blamed on the
  // wrong cause, and the reader would go looking for a missing Symbol that never existed.
  for (const dep of ir.dependencies) {
    for (const role of ["from", "to"] as const) {
      reportReservedNamespace(dep[role], `dependencies[${role}=${dep[role]}]`, out)
    }
  }
}

function reportReservedNamespace(id: string, subject: string, out: IntegrityViolation[]): void {
  const colon = id.indexOf(":")
  if (colon < 0) return
  const language = id.slice(0, colon)
  if (!RESERVED_LANGUAGE_IDS.has(language)) return
  out.push({
    invariant: 16,
    subject,
    message: `id uses the reserved language token "${language}"; ids in that namespace collide with another id kind (ir-schema.md §3.5)`,
  })
}

/**
 * Invariant #17 (ir-schema.md §14, §3.5): ids satisfy the grammars their own types claim.
 *
 * The reason this is worth a check of its own: `readIR` brands a whole parsed document in
 * one `as unknown as IR`, which is the only way to type a JSON parse, but it means every
 * `symbols[].id` and `components[].id` acquires its brand without anything having looked at
 * it. Every other route to a branded id runs a constructor first. This is what closes the
 * gap, so "holds a `SymbolId`" means the same thing for a document read off disk as for one
 * this process just built.
 *
 * Subsumes #16 for Symbols — a reserved language token also fails `isSymbolId` — but both
 * are reported, because "you used a reserved namespace" is a far more useful sentence than
 * "this is not a well-formed Symbol id".
 */
function checkIdGrammar(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    if (isSymbolId(symbol.id)) continue
    out.push({
      invariant: 17,
      subject: symbol.id,
      message: `Symbol id does not satisfy the <language>:<posix-path>#<qualified-name> grammar (ir-schema.md §3.1)`,
    })
  }
  for (const component of ir.components) {
    if (isComponentId(component.id)) continue
    out.push({
      invariant: 17,
      subject: component.id,
      message: `Component id does not satisfy the ASCII kebab-case grammar (ir-schema.md §4)`,
    })
  }
}

/**
 * Invariant #18 (ir-schema.md §14): `workspace.languages` is non-empty, every entry
 * satisfies the `LanguageId` grammar, and every `Symbol.language` appears in it.
 *
 * Three vocabularies sit close enough to this field to be mistaken for it — a plugin
 * manifest name (`lang-typescript`), the component detector's per-extension token, and an
 * npm package id — and the first was in fact projected straight into it, so every document
 * produced failed the schema's `LanguageId` pattern. The schema alone does not close this:
 * `readIR` brands a parsed document without validating it, so a document read off disk
 * reaches `buildDiff` and the projections unchecked.
 *
 * The non-emptiness clause matters for a second reason. `minItems: 1` makes an empty list
 * invalid on the wire, and it is reachable whenever no language plugin resolves — a state
 * that otherwise produces a symbol-free IR at exit 0 and, downstream, a diff of `+0 -0 ~0`
 * that passes every `--fail-on` gate.
 *
 * The subset clause is deliberately one-directional: a configured language that contributed
 * no Symbol is normal (an empty package, or every file dropped), so `workspace.languages`
 * may be a strict superset of the languages actually observed.
 */
function checkWorkspaceLanguages(ir: IR, out: IntegrityViolation[]): void {
  const declared = ir.workspace.languages
  if (declared.length === 0) {
    out.push({
      invariant: 18,
      subject: "workspace.languages",
      message:
        "workspace.languages is empty; the IR schema requires at least one entry, and an " +
        "empty list means no language plugin was resolved so nothing could be extracted",
    })
  }
  for (const language of declared) {
    if (isLanguageId(language)) continue
    out.push({
      invariant: 18,
      subject: "workspace.languages",
      message: `"${language}" does not satisfy the LanguageId grammar (ir-schema.md §3.1); a plugin manifest name is not a LanguageId`,
    })
  }
  const known = new Set<string>(declared)
  for (const symbol of ir.symbols) {
    if (known.has(symbol.language)) continue
    out.push({
      invariant: 18,
      subject: symbol.id,
      message: `Symbol.language "${symbol.language}" is not listed in workspace.languages`,
    })
  }
}

function checkSymbolIdUniqueness(ir: IR, out: IntegrityViolation[]): void {
  const seen = new Set<string>()
  for (const symbol of ir.symbols) {
    if (seen.has(symbol.id)) {
      out.push({
        invariant: 1,
        subject: symbol.id,
        message: "duplicate Symbol id",
      })
    }
    seen.add(symbol.id)
  }
}

function checkComponentIdUniqueness(ir: IR, out: IntegrityViolation[]): void {
  const seen = new Set<string>()
  for (const component of ir.components) {
    if (seen.has(component.id)) {
      out.push({
        invariant: 2,
        subject: component.id,
        message: "duplicate Component id",
      })
    }
    seen.add(component.id)
  }
}

function checkSymbolComponentRef(ir: IR, out: IntegrityViolation[]): void {
  const componentIds = new Set(ir.components.map((c) => c.id))
  for (const symbol of ir.symbols) {
    if (symbol.component === null || symbol.component === undefined) continue
    if (!componentIds.has(symbol.component)) {
      out.push({
        invariant: 3,
        subject: symbol.id,
        message: `Symbol.component "${symbol.component}" is not a declared Component id`,
      })
    }
  }
}

function checkDependencyEndpoints(ir: IR, out: IntegrityViolation[]): void {
  const symbolIds = new Set<string>(ir.symbols.map((s) => s.id))
  for (const dep of ir.dependencies) {
    for (const role of ["from", "to"] as const) {
      const endpoint = dep[role]
      if (looksLikeSymbolId(endpoint) && !symbolIds.has(endpoint)) {
        out.push({
          invariant: 4,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `dependency ${role} looks like a Symbol id but does not match any declared Symbol`,
        })
      }
    }
  }
}

function checkDroppedSymbolHasReason(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    if (symbol.dropped !== true) continue
    const reason = symbol.dropReason
    if (reason === null || reason === undefined || reason.trim().length === 0) {
      out.push({
        invariant: 5,
        subject: symbol.id,
        message: "dropped=true requires a non-empty dropReason",
      })
    }
  }
}

function checkSymbolConfidenceEnum(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    if (!CORE_CONFIDENCE_ENUM.has(symbol.confidence)) {
      out.push({
        invariant: 6,
        subject: symbol.id,
        message: `Symbol.confidence "${symbol.confidence}" is not in the core enum`,
      })
    }
  }
}

function checkEffectVocab(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    for (const effect of symbol.effects) {
      if (CORE_EFFECT_VOCAB.has(effect.id)) continue
      if (PLUGIN_EFFECT_PATTERN.test(effect.id)) continue
      out.push({
        invariant: 7,
        subject: symbol.id,
        message: `Effect.id "${effect.id}" is neither core vocab nor x-<plugin>: prefixed`,
      })
    }
  }
}

function checkSymbolKindEnum(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    if (!CORE_KIND_ENUM.has(symbol.kind)) {
      out.push({
        invariant: 8,
        subject: symbol.id,
        message: `Symbol.kind "${symbol.kind}" is not in the core enum`,
      })
    }
  }
}

function checkSymbolExtKindShape(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    const ext = symbol.extKind
    if (ext === null || ext === undefined) continue
    if (!EXT_KIND_PATTERN.test(ext)) {
      out.push({
        invariant: 9,
        subject: symbol.id,
        message: `Symbol.extKind "${ext}" does not match <namespace>(:<segment>)+ shape`,
      })
    }
  }
}

function checkPathsArePosix(ir: IR, out: IntegrityViolation[]): void {
  const pathSites: Array<{ subject: string; path: string }> = []
  for (const component of ir.components) {
    for (const root of component.roots) {
      pathSites.push({ subject: `components[id=${component.id}].roots`, path: root })
    }
  }
  for (const symbol of ir.symbols) {
    pathSites.push({ subject: symbol.id, path: symbol.source.file })
  }
  for (const manager of ir.workspace.managers) {
    for (const root of manager.roots) {
      pathSites.push({ subject: `workspace.managers[tool=${manager.tool}].roots`, path: root })
    }
  }

  for (const site of pathSites) {
    if (site.path.includes("\\")) {
      out.push({
        invariant: 10,
        subject: site.subject,
        message: `path "${site.path}" contains a backslash; only POSIX forward slashes are allowed`,
      })
    }
    if (/^([/]|[A-Za-z]:)/.test(site.path)) {
      out.push({
        invariant: 10,
        subject: site.subject,
        message: `path "${site.path}" is absolute; only workspace-relative paths are allowed`,
      })
    }
  }
}

function checkArraySortOrder(ir: IR, out: IntegrityViolation[]): void {
  assertSorted(
    ir.components.map((c) => c.id),
    "components[]",
    (a, b) => compareCodeUnit(a, b),
    out,
  )
  assertSorted(
    ir.symbols.map((s) => s.id),
    "symbols[]",
    (a, b) => compareCodeUnit(a, b),
    out,
  )
  // The IR schema pins the dependency sort key to (from, to, via) lex order and does not
  // extend the tiebreaker to `direction` / `effect`: two Dependency entries that share
  // (from, to, via) but differ in direction/effect are allowed in any order relative to
  // each other. Reproduce that shape here so the integrity check does not reject
  // schema-valid IRs.
  assertSorted(
    ir.dependencies.map((d) => `${d.from}\t${d.to}\t${d.via}`),
    "dependencies[]",
    (a, b) => compareCodeUnit(a, b),
    out,
  )
  for (const symbol of ir.symbols) {
    assertNumericSorted(
      symbol.decorators.map((d) => d.line),
      `symbols[id=${symbol.id}].decorators[].line`,
      out,
    )
    assertNumericSorted(
      symbol.rules.map((r) => r.line),
      `symbols[id=${symbol.id}].rules[].line`,
      out,
    )
    assertEffectSegmentation(symbol, out)
    assertNumericSorted(
      symbol.calls.map((c) => c.line),
      `symbols[id=${symbol.id}].calls[].line`,
      out,
    )
  }
}

function assertSorted<T>(
  values: readonly T[],
  collection: string,
  compare: (a: T, b: T) => number,
  out: IntegrityViolation[],
): void {
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]
    const curr = values[i]
    if (prev === undefined || curr === undefined) continue
    if (compare(prev, curr) > 0) {
      out.push({
        invariant: 11,
        subject: collection,
        message: `${collection} not sorted: "${String(prev)}" precedes "${String(curr)}"`,
      })
      return
    }
  }
}

function assertNumericSorted(
  values: readonly number[],
  collection: string,
  out: IntegrityViolation[],
): void {
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]
    const curr = values[i]
    if (prev === undefined || curr === undefined) continue
    if (prev > curr) {
      out.push({
        invariant: 11,
        subject: collection,
        message: `${collection} not sorted: line ${prev} precedes ${curr}`,
      })
      return
    }
  }
}

/**
 * Compare two strings by UTF-16 code unit (matches `Array.prototype.sort` default and the
 * `<` operator on strings). BMP-only strings coincide with Unicode codepoint order; astral-
 * plane strings differ, but the serializer, the schema, and every generator that uses the
 * default JS ordering all agree on this comparator so the three paths cannot diverge.
 */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Endpoint discrimination (§11): does this endpoint carry the `<language>:<path>#<qname>`
 * silhouette, i.e. is it *meant* to be a Symbol id rather than a Component id?
 *
 * Deliberately looser than `isSymbolId` from ./id, which answers the different question of
 * whether a string is a well-formed Symbol id. An endpoint that was meant to be one but is
 * malformed — a backslash in the path, say — must still be routed to the Symbol-id
 * invariants so the breach is reported, instead of being waved through as a Component id
 * that happens not to be declared.
 *
 * Returns a plain boolean rather than narrowing to `SymbolId`, precisely because it is the
 * looser test: a predicate here would hand out the brand to strings `makeSymbolId` refuses,
 * and "holds a `SymbolId` ⇒ passed the constructor" would stop being true. The lookups this
 * feeds are keyed by `string` for the same reason — they are membership tests over ids read
 * from a document, not proofs about them.
 */
function looksLikeSymbolId(endpoint: DependencyEndpoint): boolean {
  return SYMBOL_ID_PATTERN.test(endpoint)
}

/**
 * Invariant #11 — `effects[]` segmentation (effect-propagation.md §5.1, §8).
 *
 *   1. All locally-detected entries (`propagated !== true`) precede all
 *      propagated entries (`propagated === true`).
 *   2. Local segment: `line` is required and monotonically ascending.
 *   3. Propagated segment: `line` is absent; `derivedFrom` is present and
 *      non-empty; `(id, target)` is monotonically ascending.
 *
 * These three sub-checks jointly reproduce the schema-side `if/then/else` on
 * `Effect` (aburi.ir.v1.json) as a set of readable integrity messages the
 * pre-serialize surface can point at.
 */
function assertEffectSegmentation(symbol: IR["symbols"][number], out: IntegrityViolation[]): void {
  const subject = `symbols[id=${symbol.id}].effects[]`
  const firstPropagated = symbol.effects.findIndex((e) => e.propagated === true)
  if (firstPropagated >= 0) {
    for (let i = firstPropagated + 1; i < symbol.effects.length; i++) {
      const entry = symbol.effects[i]
      if (entry === undefined) continue
      if (entry.propagated !== true) {
        out.push({
          invariant: 11,
          subject,
          message: `${subject}: locally-detected entry appears after a propagated entry (${entry.id}/${entry.target})`,
        })
        break
      }
    }
  }
  const locals: Array<{ line?: number; id: string; target: string }> = []
  const propagated: Array<{ id: string; target: string }> = []
  for (const effect of symbol.effects) {
    if (effect.propagated === true) {
      if (effect.line !== undefined) {
        out.push({
          invariant: 11,
          subject,
          message: `${subject}: propagated entry (${effect.id}/${effect.target}) carries line=${effect.line}; propagated entries must omit line`,
        })
      }
      if (effect.derivedFrom === undefined || effect.derivedFrom.length === 0) {
        out.push({
          invariant: 11,
          subject,
          message: `${subject}: propagated entry (${effect.id}/${effect.target}) missing non-empty derivedFrom`,
        })
      }
      propagated.push({ id: effect.id, target: effect.target })
    } else {
      if (effect.line === undefined) {
        out.push({
          invariant: 11,
          subject,
          message: `${subject}: locally-detected entry (${effect.id}/${effect.target}) missing line`,
        })
      }
      const entry: { line?: number; id: string; target: string } = {
        id: effect.id,
        target: effect.target,
      }
      if (effect.line !== undefined) entry.line = effect.line
      locals.push(entry)
    }
  }
  assertNumericSorted(
    locals.filter((e) => e.line !== undefined).map((e) => e.line as number),
    `${subject}/local.line`,
    out,
  )
  assertSorted(
    propagated.map((e) => `${e.id}\t${e.target}`),
    `${subject}/propagated(id,target)`,
    compareCodeUnit,
    out,
  )
}

/**
 * Invariant #12 (ir-schema.md §14): a `via: "call"` Dependency is a projection of
 * a resolved call edge, so both endpoints MUST be Symbol ids AND both MUST exist
 * in `symbols[]` as `dropped: false` entries. This strengthens #4 (which only
 * rejects a *dangling* symbol id) by additionally rejecting component-id
 * endpoints on call edges (a call edge can never target a whole component) and
 * by rejecting edges that point at Symbols whose body was dropped by Category
 * B/C rules — those Symbols carry no body, zeroed fingerprints, and would
 * silently corrupt effect propagation.
 */
function checkCallEdgeEndpoints(ir: IR, out: IntegrityViolation[]): void {
  const symbolsById = new Map<string, IRSymbol>(ir.symbols.map((s) => [s.id, s]))
  for (const dep of ir.dependencies) {
    if (dep.via !== "call") continue
    for (const role of ["from", "to"] as const) {
      const endpoint = dep[role]
      if (!looksLikeSymbolId(endpoint)) {
        out.push({
          invariant: 12,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `via:"call" dependency ${role} must be a Symbol id, got "${endpoint}"`,
        })
        continue
      }
      const target = symbolsById.get(endpoint)
      if (target === undefined) {
        out.push({
          invariant: 12,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `via:"call" dependency ${role} "${endpoint}" is not a declared Symbol`,
        })
        continue
      }
      if (target.dropped) {
        out.push({
          invariant: 12,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `via:"call" dependency ${role} "${endpoint}" points at a dropped Symbol`,
        })
      }
    }
  }
}

/**
 * Invariant #13 (ir-schema.md §14): `(from, to, via)` triples in `dependencies[]`
 * must be unique. Direction / effect are deliberately excluded from identity —
 * `diff-algorithm.md §6.2` surfaces direction/effect flips as an added+removed
 * pair on the same key, so duplicate triples with differing direction/effect
 * would silently corrupt the diff output.
 */
function checkDependencyTupleUniqueness(ir: IR, out: IntegrityViolation[]): void {
  const seen = new Set<string>()
  for (const dep of ir.dependencies) {
    const key = `${dep.from}\t${dep.to}\t${dep.via}`
    if (seen.has(key)) {
      out.push({
        invariant: 13,
        subject: `dependencies[from=${dep.from},to=${dep.to},via=${dep.via}]`,
        message: "duplicate (from, to, via) triple in dependencies[]",
      })
      continue
    }
    seen.add(key)
  }
}

/**
 * Invariant #14 (ir-schema.md §14): the call-graph projection is total in both
 * directions. Every `Symbol.calls[].resolved !== null` must correspond to a
 * `via: "call"` Dependency `(from = caller.id, to = resolved)`; conversely every
 * `via: "call"` Dependency must be backed by at least one such Call entry. This
 * catches (a) an emitter that produced calls but forgot to project them into
 * `dependencies[]`, and (b) a scripted patch that added or removed Dependencies
 * without touching the corresponding `Symbol.calls[]`.
 */
function checkCallGraphProjectionAgrees(ir: IR, out: IntegrityViolation[]): void {
  const expectedFromCalls = new Set<string>()
  for (const symbol of ir.symbols) {
    for (const call of symbol.calls) {
      if (call.resolved === null) continue
      expectedFromCalls.add(dependencyKey(symbol.id, call.resolved))
    }
  }

  const foundInDeps = new Set<string>()
  for (const dep of ir.dependencies) {
    if (dep.via !== "call") continue
    foundInDeps.add(dependencyKey(dep.from, dep.to))
  }

  for (const key of expectedFromCalls) {
    if (!foundInDeps.has(key)) {
      const [from, to] = key.split("\t")
      out.push({
        invariant: 14,
        subject: `dependencies[from=${from},to=${to},via=call]`,
        message: `Symbol.calls[].resolved -> ${to} has no matching via:"call" Dependency`,
      })
    }
  }
  for (const key of foundInDeps) {
    if (!expectedFromCalls.has(key)) {
      const [from, to] = key.split("\t")
      out.push({
        invariant: 14,
        subject: `symbols[id=${from}].calls[resolved=${to}]`,
        message: `via:"call" Dependency ${from} -> ${to} has no matching Symbol.calls[].resolved entry`,
      })
    }
  }
}

function dependencyKey(from: string, to: string): string {
  return `${from}\t${to}`
}

/**
 * Invariant #15 (call-resolution.md §8.1): when `stats.callResolution` is
 * present it must be a faithful census of `Symbol.calls[]`. `totalCalls` counts
 * every call site, `resolvedCalls` counts the non-null ones, and the five
 * buckets account for the remainder. A drift here means a counter was
 * incremented on a path the IR does not reflect — which would send reviewers
 * hunting for unresolved calls that are not there, or hide the ones that are.
 */
function checkCallResolutionStatsCensus(ir: IR, out: IntegrityViolation[]): void {
  const stats = ir.stats.callResolution
  if (stats === undefined) return

  let totalCalls = 0
  let resolvedCalls = 0
  for (const symbol of ir.symbols) {
    totalCalls += symbol.calls.length
    for (const call of symbol.calls) if (call.resolved !== null) resolvedCalls++
  }

  if (stats.totalCalls !== totalCalls) {
    out.push({
      invariant: 15,
      subject: "stats.callResolution.totalCalls",
      message: `stats.callResolution.totalCalls is ${stats.totalCalls} but symbols[] carry ${totalCalls} call sites`,
    })
  }
  if (stats.resolvedCalls !== resolvedCalls) {
    out.push({
      invariant: 15,
      subject: "stats.callResolution.resolvedCalls",
      message: `stats.callResolution.resolvedCalls is ${stats.resolvedCalls} but symbols[] carry ${resolvedCalls} resolved calls`,
    })
  }

  const { unresolved } = stats
  const bucketed =
    unresolved.localScope +
    unresolved.external +
    unresolved.dynamic +
    unresolved.ambiguous +
    unresolved.noMatch
  if (bucketed !== stats.totalCalls - stats.resolvedCalls) {
    out.push({
      invariant: 15,
      subject: "stats.callResolution.unresolved",
      message: `bucket counts sum to ${bucketed} but totalCalls - resolvedCalls is ${stats.totalCalls - stats.resolvedCalls}`,
    })
  }
}
