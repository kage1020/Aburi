import type { IntegrityViolation } from "./errors"

type FieldSpec =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "stringArray" }
  | { kind: "nullable"; inner: FieldSpec }
  | { kind: "record"; spec: RecordSpec }
  | { kind: "recordArray"; spec: RecordSpec }
  | { kind: "optional"; inner: FieldSpec }

interface RecordSpec {
  readonly [field: string]: FieldSpec
}

const str: FieldSpec = { kind: "string" }
const num: FieldSpec = { kind: "number" }
const bool: FieldSpec = { kind: "boolean" }
const strs: FieldSpec = { kind: "stringArray" }
const nullable = (inner: FieldSpec): FieldSpec => ({ kind: "nullable", inner })
const optional = (inner: FieldSpec): FieldSpec => ({ kind: "optional", inner })
const record = (spec: RecordSpec): FieldSpec => ({ kind: "record", spec })
const recordArray = (spec: RecordSpec): FieldSpec => ({ kind: "recordArray", spec })

const PLUGIN_REF: RecordSpec = {
  name: str,
  type: str,
  version: str,
  grammarRevision: nullable(str),
}

const GENERATOR: RecordSpec = { name: str, version: str, plugins: recordArray(PLUGIN_REF) }

const WORKSPACE_MANAGER: RecordSpec = { tool: str, roots: strs }

const WORKSPACE: RecordSpec = {
  root: str,
  managers: recordArray(WORKSPACE_MANAGER),
  languages: strs,
}

const COMPONENT: RecordSpec = {
  id: str,
  name: str,
  roots: strs,
  languages: strs,
  publicApi: optional(strs),
  frameworks: optional(strs),
  description: optional(nullable(str)),
}

const DECORATOR: RecordSpec = {
  name: str,
  qualifier: optional(str),
  raw: str,
  arguments: strs,
  boundary: bool,
  line: num,
}

const RULE: RecordSpec = {
  type: str,
  line: num,
  condition: nullable(str),
  what: nullable(str),
  expr: nullable(str),
  loopKind: nullable(str),
}

const EFFECT: RecordSpec = {
  id: str,
  target: str,
  plugin: str,
  confidence: str,
  derivedBy: str,
  line: optional(num),
  propagated: optional(bool),
  derivedFrom: optional(strs),
}

const CALL: RecordSpec = { target: str, line: num, resolved: nullable(str) }

const SOURCE_RANGE: RecordSpec = {
  file: str,
  startLine: num,
  endLine: num,
  startColumn: optional(nullable(num)),
  endColumn: optional(nullable(num)),
}

const FINGERPRINT: RecordSpec = { api: str, logic: str, syntax: str }

const SIGNATURE: RecordSpec = {
  inputs: recordArray({
    name: str,
    type: str,
    optional: optional(bool),
    rest: optional(bool),
    bindings: optional(strs),
  }),
  outputs: strs,
  throws: strs,
  inferredThrows: optional(strs),
  async: bool,
  generator: bool,
  typeParameters: strs,
}

const SYMBOL: RecordSpec = {
  id: str,
  kind: str,
  extKind: nullable(str),
  name: str,
  language: str,
  component: optional(nullable(str)),
  visibility: str,
  decorators: recordArray(DECORATOR),
  signature: optional(nullable(record(SIGNATURE))),
  rules: recordArray(RULE),
  effects: recordArray(EFFECT),
  calls: recordArray(CALL),
  source: record(SOURCE_RANGE),
  fingerprint: record(FINGERPRINT),
  confidence: str,
  derivedBy: strs,
  dropped: bool,
  dropReason: nullable(str),
}

const DEPENDENCY: RecordSpec = {
  from: str,
  to: str,
  via: str,
  direction: str,
  effect: nullable(str),
}

const EFFECT_PROPAGATION_STATS: RecordSpec = {
  sccCount: num,
  maxSccSize: num,
  propagatedEffectCount: num,
  symbolsWithPropagatedEffects: num,
}

const EFFECT_CLASSIFY_TIMEOUT: RecordSpec = { plugin: str, symbolId: str, timeoutMs: num }

const LSP_HINT_REJECTIONS: RecordSpec = {
  unparseableHover: num,
  ownerClassNotFound: num,
  memberNotFound: num,
  kindMismatch: num,
  targetDropped: num,
}

const LSP_ENRICHMENT_STATS: RecordSpec = {
  enabled: bool,
  filesEnriched: num,
  filesFellBack: num,
  requestsIssued: num,
  requestsTimedOut: num,
  requestsFailed: num,
  languagesDisabled: strs,
  hintsProduced: optional(num),
  hintsConsumed: optional(num),
  hintsRejected: optional(record(LSP_HINT_REJECTIONS)),
}

const UNRESOLVED_CALL_BUCKETS: RecordSpec = {
  localScope: num,
  external: num,
  dynamic: num,
  ambiguous: num,
  noMatch: num,
}

const CALL_RESOLUTION_STATS: RecordSpec = {
  totalCalls: num,
  resolvedCalls: num,
  unresolved: record(UNRESOLVED_CALL_BUCKETS),
}

const SKIPPED_FILE: RecordSpec = {
  path: str,
  reason: str,
}

const STATS: RecordSpec = {
  totalFiles: num,
  parsedFiles: num,
  keptSymbols: num,
  droppedSymbols: num,
  effectPropagation: record(EFFECT_PROPAGATION_STATS),
  effectClassifyTimeouts: optional(recordArray(EFFECT_CLASSIFY_TIMEOUT)),
  lspEnrichment: optional(record(LSP_ENRICHMENT_STATS)),
  callResolution: optional(record(CALL_RESOLUTION_STATS)),
  skippedFiles: optional(recordArray(SKIPPED_FILE)),
}

const DOCUMENT: RecordSpec = {
  $schema: str,
  generatedAt: optional(str),
  generator: record(GENERATOR),
  workspace: record(WORKSPACE),
  components: recordArray(COMPONENT),
  symbols: recordArray(SYMBOL),
  dependencies: recordArray(DEPENDENCY),
  stats: record(STATS),
}

export const DOCUMENT_SHAPE: Readonly<Record<string, RecordSpec>> = {
  $: DOCUMENT,
  Generator: GENERATOR,
  PluginRef: PLUGIN_REF,
  Workspace: WORKSPACE,
  WorkspaceManager: WORKSPACE_MANAGER,
  Component: COMPONENT,
  Decorator: DECORATOR,
  Rule: RULE,
  Effect: EFFECT,
  Call: CALL,
  SourceRange: SOURCE_RANGE,
  Fingerprint: FINGERPRINT,
  Signature: SIGNATURE,
  Symbol: SYMBOL,
  Dependency: DEPENDENCY,
  Stats: STATS,
  EffectPropagationStats: EFFECT_PROPAGATION_STATS,
  EffectClassifyTimeout: EFFECT_CLASSIFY_TIMEOUT,
  LspEnrichmentStats: LSP_ENRICHMENT_STATS,
  LspHintRejections: LSP_HINT_REJECTIONS,
  CallResolutionStats: CALL_RESOLUTION_STATS,
  UnresolvedCallBuckets: UNRESOLVED_CALL_BUCKETS,
  SkippedFile: SKIPPED_FILE,
}

export function checkDocumentShape(document: unknown): IntegrityViolation[] {
  const out: IntegrityViolation[] = []
  if (!isRecord(document)) {
    out.push(violation(DOCUMENT_SUBJECT, `Document is ${describe(document)}, not an object`))
    return out
  }
  checkRecord(document, DOCUMENT_SUBJECT, DOCUMENT, out)
  return out
}

function checkRecord(
  value: Record<string, unknown>,
  subject: string,
  spec: RecordSpec,
  out: IntegrityViolation[],
): void {
  for (const [field, fieldSpec] of Object.entries(spec)) {
    checkField(value[field], subject, field, fieldSpec, out)
  }
}

function checkField(
  value: unknown,
  subject: string,
  field: string,
  spec: FieldSpec,
  out: IntegrityViolation[],
): void {
  switch (spec.kind) {
    case "optional":
      if (value === undefined) return
      checkField(value, subject, field, spec.inner, out)
      return
    case "nullable":
      if (value === null) return
      checkField(value, subject, field, spec.inner, out)
      return
    case "string":
      if (typeof value !== "string") {
        out.push(violation(subject, `"${field}" is ${describe(value)}, not a string`))
      }
      return
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        out.push(violation(subject, `"${field}" is ${describe(value)}, not a finite number`))
      }
      return
    case "boolean":
      if (typeof value !== "boolean") {
        out.push(violation(subject, `"${field}" is ${describe(value)}, not a boolean`))
      }
      return
    case "stringArray":
      if (!Array.isArray(value)) {
        out.push(violation(subject, `"${field}" is ${describe(value)}, not an array`))
        return
      }
      for (const [index, entry] of value.entries()) {
        if (typeof entry === "string") continue
        out.push(
          violation(`${subject}.${field}[${index}]`, `entry is ${describe(entry)}, not a string`),
        )
      }
      return
    case "record":
      if (!isRecord(value)) {
        out.push(violation(subject, `"${field}" is ${describe(value)}, not an object`))
        return
      }
      checkRecord(value, `${subject}.${field}`, spec.spec, out)
      return
    case "recordArray":
      if (!Array.isArray(value)) {
        out.push(violation(subject, `"${field}" is ${describe(value)}, not an array`))
        return
      }
      for (const [index, entry] of value.entries()) {
        const entrySubject = `${subject}.${field}[${index}]`
        if (!isRecord(entry)) {
          out.push(violation(entrySubject, `entry is ${describe(entry)}, not an object`))
          continue
        }
        checkRecord(entry, entrySubject, spec.spec, out)
      }
      return
  }
}

export const DOCUMENT_SUBJECT = "document"

function violation(subject: string, message: string): IntegrityViolation {
  return { invariant: 20, subject: subject.replace(`${DOCUMENT_SUBJECT}.`, ""), message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === undefined) return "absent"
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "number" && !Number.isFinite(value)) return String(value)
  return `a ${typeof value}`
}
