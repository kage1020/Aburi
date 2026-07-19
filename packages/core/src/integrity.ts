import type { IR } from "@aburi/types"
import { CoreError, type IntegrityViolation } from "./errors"

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
 * The 14 invariants checked here are:
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
  const symbolIds = new Set(ir.symbols.map((s) => s.id))
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

function looksLikeSymbolId(endpoint: string): boolean {
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
  const symbolsById = new Map(ir.symbols.map((s) => [s.id, s]))
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
