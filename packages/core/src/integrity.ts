import type { DependencyEndpoint, IR, Symbol as IRSymbol } from "@aburi/types"
import { CALL_SITE_KEY_SEPARATOR, callEdgeKey, dependencyKey } from "./call-site"
import { describeCodePoints, toNfc } from "./codepoints"
import { CoreError, type IntegrityViolation } from "./errors"
import {
  isComponentId,
  isLanguageId,
  isQualifiedName,
  isSymbolId,
  posixWorkspaceRelativeViolation,
  RESERVED_LANGUAGE_IDS,
} from "./id"
import { checkDocumentShape } from "./integrity-shape"
import { compareCodeUnit } from "./order"

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

/** Whether `id` is one of the core effect ids, which no plugin owns and any may emit. */
export function isCoreEffectId(id: string): boolean {
  return CORE_EFFECT_VOCAB.has(id)
}

/** Symbol.kind core enumeration. */
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

/** Symbol.confidence enumeration. */
const CORE_CONFIDENCE_ENUM: ReadonlySet<string> = new Set(["high", "medium", "low"])

/** Plugin-extension effect prefix: `x-<plugin>:<action>`. */
const PLUGIN_EFFECT_PATTERN = /^x-[a-z][a-z0-9-]*:[a-z][a-z0-9.-]+$/

/** `<namespace>(:<segment>)+`, at least two segments, lowercase ASCII. */
const EXT_KIND_PATTERN = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9.-]*)+$/

/** Symbol id shape: `<language>:<file-path>#<qualified-name>`. */
const SYMBOL_ID_PATTERN = /^[a-z][a-z0-9]*:[^#]+#.+$/

export function checkIRIntegrity(document: unknown): IntegrityViolation[] {
  const shape = checkDocumentShape(document)
  if (shape.length > 0) return shape

  const ir = document as IR
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
  checkSkippedFilesCensus(ir, violations)
  checkSymbolIdNamespace(ir, violations)
  checkIdGrammar(ir, violations)
  checkWorkspaceLanguages(ir, violations)
  checkUnicodeNormalization(ir, violations)

  return violations
}

/** Throwing variant: same checks, aggregates every violation into one CoreError. */
export function assertIRIntegrity(document: unknown): void {
  const violations = checkIRIntegrity(document)
  if (violations.length === 0) return
  const summary = violations.map((v) => `[#${v.invariant}] ${v.subject}: ${v.message}`).join("; ")
  throw new CoreError(`IR integrity check failed (${violations.length}): ${summary}`, {
    code: "integrity-violation",
    violations,
  })
}

function checkSymbolIdNamespace(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    reportReservedNamespace(symbol.id, symbol.id, out)
  }
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
    message: `id uses the reserved language token "${language}"; ids in that namespace collide with another id kind (ir-schema.md)`,
  })
}

function checkIdGrammar(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    if (!isSymbolId(symbol.id)) {
      out.push({
        invariant: 17,
        subject: symbol.id,
        message: `Symbol id does not satisfy the <language>:<posix-path>#<qualified-name> grammar (ir-schema.md)`,
      })
    }
    if (!isQualifiedName(symbol.name)) {
      out.push({
        invariant: 17,
        subject: symbol.id,
        message: `Symbol.name "${symbol.name}" does not satisfy the qualified-name grammar (ir-schema.md)`,
      })
    }
  }
  for (const component of ir.components) {
    if (isComponentId(component.id)) continue
    out.push({
      invariant: 17,
      subject: component.id,
      message: `Component id does not satisfy the ASCII kebab-case grammar (ir-schema.md)`,
    })
  }
}

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
      message: `"${language}" does not satisfy the LanguageId grammar (ir-schema.md); a plugin manifest name is not a LanguageId`,
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

function checkUnicodeNormalization(ir: IR, out: IntegrityViolation[]): void {
  for (const component of ir.components) {
    for (const root of component.roots) {
      reportUnnormalized(root, `components[id=${component.id}].roots`, "root", out)
    }
    for (const pattern of component.publicApi ?? []) {
      reportUnnormalized(pattern, `components[id=${component.id}].publicApi`, "pattern", out)
    }
  }
  for (const manager of ir.workspace.managers) {
    for (const root of manager.roots) {
      reportUnnormalized(root, `workspace.managers[tool=${manager.tool}].roots`, "root", out)
    }
  }
  for (const symbol of ir.symbols) {
    reportUnnormalized(symbol.name, symbol.id, "name", out)
    reportUnnormalized(symbol.source.file, symbol.id, "source.file", out)
    for (const [index, effect] of symbol.effects.entries()) {
      reportUnnormalized(effect.target, symbol.id, `effects[${index}].target`, out)
    }
    for (const [index, call] of symbol.calls.entries()) {
      reportUnnormalized(call.target, symbol.id, `calls[${index}].target`, out)
    }
  }
  for (const dep of ir.dependencies) {
    for (const role of ["from", "to"] as const) {
      reportUnnormalized(dep[role], `dependencies[${role}=${dep[role]}]`, role, out)
    }
  }
  for (const file of ir.stats.skippedFiles ?? []) {
    reportUnnormalized(file.path, `stats.skippedFiles[path=${file.path}]`, "path", out)
  }
}

function reportUnnormalized(
  value: string,
  subject: string,
  field: string,
  out: IntegrityViolation[],
): void {
  if (value === toNfc(value)) return
  out.push({
    invariant: 19,
    subject,
    message: `${field} ${describeCodePoints(value)} is not in Unicode NFC; write it as ${describeCodePoints(toNfc(value))}`,
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
  for (const file of ir.stats.skippedFiles ?? []) {
    pathSites.push({ subject: `stats.skippedFiles[path=${file.path}]`, path: file.path })
  }

  for (const site of pathSites) {
    const violation = posixWorkspaceRelativeViolation(site.path)
    if (violation === null) continue
    out.push({ invariant: 10, subject: site.subject, message: violation.message })
  }
}

function checkArraySortOrder(ir: IR, out: IntegrityViolation[]): void {
  assertSorted(
    ir.components.map((c) => c.id),
    "components[]",
    compareCodeUnit,
    out,
  )
  assertSorted(
    ir.symbols.map((s) => s.id),
    "symbols[]",
    compareCodeUnit,
    out,
  )
  assertSorted(
    (ir.stats.skippedFiles ?? []).map((f) => f.path),
    "stats.skippedFiles[]",
    compareCodeUnit,
    out,
  )
  assertSorted(
    ir.dependencies.map((d) => dependencyKey(d.from, d.to, d.via)),
    "dependencies[]",
    compareCodeUnit,
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
  describePair: (prev: T, curr: T) => string = (prev, curr) =>
    `"${String(prev)}" precedes "${String(curr)}"`,
): void {
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]
    const curr = values[i]
    if (prev === undefined || curr === undefined) continue
    if (compare(prev, curr) > 0) {
      out.push({
        invariant: 11,
        subject: collection,
        message: `${collection} not sorted: ${describePair(prev, curr)}`,
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
  assertSorted(
    values,
    collection,
    (a, b) => a - b,
    out,
    (prev, curr) => `line ${prev} precedes ${curr}`,
  )
}

function looksLikeSymbolId(endpoint: DependencyEndpoint): boolean {
  return SYMBOL_ID_PATTERN.test(endpoint)
}

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
      if (target.dropped === true) {
        out.push({
          invariant: 12,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `via:"call" dependency ${role} "${endpoint}" points at a dropped Symbol`,
        })
      }
    }
  }
}

function checkDependencyTupleUniqueness(ir: IR, out: IntegrityViolation[]): void {
  const seen = new Set<string>()
  for (const dep of ir.dependencies) {
    const key = dependencyKey(dep.from, dep.to, dep.via)
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

function checkCallGraphProjectionAgrees(ir: IR, out: IntegrityViolation[]): void {
  const expectedFromCalls = new Set<string>()
  for (const symbol of ir.symbols) {
    for (const call of symbol.calls) {
      if (call.resolved === null) continue
      expectedFromCalls.add(callEdgeKey(symbol.id, call.resolved))
    }
  }

  const foundInDeps = new Set<string>()
  for (const dep of ir.dependencies) {
    if (dep.via !== "call") continue
    foundInDeps.add(callEdgeKey(dep.from, dep.to))
  }

  for (const key of expectedFromCalls) {
    if (!foundInDeps.has(key)) {
      const [from, to] = key.split(CALL_SITE_KEY_SEPARATOR)
      out.push({
        invariant: 14,
        subject: `dependencies[from=${from},to=${to},via=call]`,
        message: `Symbol.calls[].resolved -> ${to} has no matching via:"call" Dependency`,
      })
    }
  }
  for (const key of foundInDeps) {
    if (!expectedFromCalls.has(key)) {
      const [from, to] = key.split(CALL_SITE_KEY_SEPARATOR)
      out.push({
        invariant: 14,
        subject: `symbols[id=${from}].calls[resolved=${to}]`,
        message: `via:"call" Dependency ${from} -> ${to} has no matching Symbol.calls[].resolved entry`,
      })
    }
  }
}

function checkSkippedFilesCensus(ir: IR, out: IntegrityViolation[]): void {
  const unparsed = ir.stats.totalFiles - ir.stats.parsedFiles
  if (unparsed < 0) {
    out.push({
      invariant: 21,
      subject: "stats.parsedFiles",
      message: `stats.parsedFiles is ${ir.stats.parsedFiles} of ${ir.stats.totalFiles} total file(s); a scan cannot parse more files than it found`,
    })
  }

  const skippedFiles = ir.stats.skippedFiles
  if (skippedFiles === undefined) return

  if (skippedFiles.length !== unparsed) {
    out.push({
      invariant: 21,
      subject: "stats.skippedFiles",
      message: `stats.skippedFiles names ${skippedFiles.length} file(s) but totalFiles - parsedFiles is ${unparsed}`,
    })
  }

  const seen = new Set<string>()
  for (const file of skippedFiles) {
    if (seen.has(file.path)) {
      out.push({
        invariant: 21,
        subject: "stats.skippedFiles",
        message: `stats.skippedFiles names "${file.path}" more than once; one file is skipped for one reason`,
      })
      continue
    }
    seen.add(file.path)
  }
}

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
