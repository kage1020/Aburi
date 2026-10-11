import type { IR } from "@aburi/types"
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
import { checkCallResolutionStatsCensus, checkSkippedFilesCensus } from "./integrity-census"
import {
  checkCallEdgeEndpoints,
  checkCallGraphProjectionAgrees,
  checkDependencyEndpoints,
  checkDependencyTupleUniqueness,
} from "./integrity-dependencies"
import { checkArraySortOrder } from "./integrity-order"
import { checkDocumentShape } from "./integrity-shape"

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

const CORE_CONFIDENCE_ENUM: ReadonlySet<string> = new Set(["high", "medium", "low"])

const PLUGIN_EFFECT_PATTERN = /^x-[a-z][a-z0-9-]*:[a-z][a-z0-9.-]+$/

const EXT_KIND_PATTERN = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9.-]*)+$/

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
    message: `id uses the reserved language token "${language}"; ids in that namespace collide with another id kind`,
  })
}

function checkIdGrammar(ir: IR, out: IntegrityViolation[]): void {
  for (const symbol of ir.symbols) {
    if (!isSymbolId(symbol.id)) {
      out.push({
        invariant: 17,
        subject: symbol.id,
        message: `Symbol id does not satisfy the <language>:<posix-path>#<qualified-name> grammar`,
      })
    }
    if (!isQualifiedName(symbol.name)) {
      out.push({
        invariant: 17,
        subject: symbol.id,
        message: `Symbol.name "${symbol.name}" does not satisfy the qualified-name grammar`,
      })
    }
  }
  for (const component of ir.components) {
    if (isComponentId(component.id)) continue
    out.push({
      invariant: 17,
      subject: component.id,
      message: `Component id does not satisfy the ASCII kebab-case grammar`,
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
      message: `"${language}" does not satisfy the LanguageId grammar; a plugin manifest name is not a LanguageId`,
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
