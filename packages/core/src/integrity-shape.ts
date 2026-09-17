import type { IntegrityViolation } from "./errors"

/**
 * Invariant #20 (ir-schema.md §14): the Document has the shape `aburi.ir.v1` requires.
 *
 * The other nineteen invariants, and every consumer that holds the branded `IR` type, are
 * written against a Document of that shape. Nothing in the pipeline establishes it: `readIR`
 * checks `$schema` and hands the parsed object to `checkIRIntegrity`, so this is the only
 * gate a Document read off disk passes. A gate whose answer to a malformed input is a
 * `TypeError` has no answer — the caller asked which invariant broke and got an internal
 * crash, which is the question the list exists to answer.
 *
 * Scoped to the schema's structural requirements rather than to "the fields the invariants
 * happen to read". The narrower reading is tempting and wrong: `readIR` brands its result
 * `IR`, so what this check establishes is what that brand asserts, and a check that covered
 * less would hand `@aburi/diff` an object missing `fingerprint` and let it crash outside
 * anyone's error handling. `test/integrity-shape-drift.test.ts` reads
 * `schema/aburi.ir.v1.json` and fails when a `required` entry has no line here, so the
 * duplication is checked rather than trusted.
 *
 * What is *not* checked: value grammars, enum membership, cross-field relations, array
 * ordering. Those are the other nineteen invariants, and they run once this one is clean.
 */
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

const stringField: FieldSpec = { kind: "string" }
const numberField: FieldSpec = { kind: "number" }
const booleanField: FieldSpec = { kind: "boolean" }
const stringArrayField: FieldSpec = { kind: "stringArray" }
const nullable = (inner: FieldSpec): FieldSpec => ({ kind: "nullable", inner })
const optional = (inner: FieldSpec): FieldSpec => ({ kind: "optional", inner })
const record = (spec: RecordSpec): FieldSpec => ({ kind: "record", spec })
const recordArray = (spec: RecordSpec): FieldSpec => ({ kind: "recordArray", spec })

const PLUGIN_REF: RecordSpec = {
  name: stringField,
  type: stringField,
  version: stringField,
  grammarRevision: nullable(stringField),
}

const GENERATOR: RecordSpec = {
  name: stringField,
  version: stringField,
  plugins: recordArray(PLUGIN_REF),
}

const WORKSPACE_MANAGER: RecordSpec = { tool: stringField, roots: stringArrayField }

const WORKSPACE: RecordSpec = {
  root: stringField,
  managers: recordArray(WORKSPACE_MANAGER),
  languages: stringArrayField,
}

const COMPONENT: RecordSpec = {
  id: stringField,
  name: stringField,
  roots: stringArrayField,
  languages: stringArrayField,
  publicApi: optional(stringArrayField),
  frameworks: optional(stringArrayField),
  description: optional(nullable(stringField)),
}

const DECORATOR: RecordSpec = {
  name: stringField,
  raw: stringField,
  arguments: stringArrayField,
  boundary: booleanField,
  line: numberField,
}

const RULE: RecordSpec = {
  type: stringField,
  line: numberField,
  condition: nullable(stringField),
  what: nullable(stringField),
  expr: nullable(stringField),
  loopKind: nullable(stringField),
}

const EFFECT: RecordSpec = {
  id: stringField,
  target: stringField,
  plugin: stringField,
  confidence: stringField,
  derivedBy: stringField,
  line: optional(numberField),
  propagated: optional(booleanField),
  derivedFrom: optional(stringArrayField),
}

const CALL: RecordSpec = { target: stringField, line: numberField, resolved: nullable(stringField) }

const SOURCE_RANGE: RecordSpec = {
  file: stringField,
  startLine: numberField,
  endLine: numberField,
  startColumn: optional(nullable(numberField)),
  endColumn: optional(nullable(numberField)),
}

const FINGERPRINT: RecordSpec = { api: stringField, logic: stringField, syntax: stringField }

const SIGNATURE: RecordSpec = {
  inputs: recordArray({ name: stringField, type: stringField }),
  outputs: stringArrayField,
  throws: stringArrayField,
  inferredThrows: optional(stringArrayField),
  async: booleanField,
  generator: booleanField,
  typeParameters: stringArrayField,
}

const SYMBOL: RecordSpec = {
  id: stringField,
  kind: stringField,
  extKind: nullable(stringField),
  name: stringField,
  language: stringField,
  component: optional(nullable(stringField)),
  visibility: stringField,
  decorators: recordArray(DECORATOR),
  signature: optional(nullable(record(SIGNATURE))),
  rules: recordArray(RULE),
  effects: recordArray(EFFECT),
  calls: recordArray(CALL),
  source: record(SOURCE_RANGE),
  fingerprint: record(FINGERPRINT),
  confidence: stringField,
  derivedBy: stringArrayField,
  dropped: booleanField,
  dropReason: nullable(stringField),
}

const DEPENDENCY: RecordSpec = {
  from: stringField,
  to: stringField,
  via: stringField,
  direction: stringField,
  effect: nullable(stringField),
}

const EFFECT_PROPAGATION_STATS: RecordSpec = {
  sccCount: numberField,
  maxSccSize: numberField,
  propagatedEffectCount: numberField,
  symbolsWithPropagatedEffects: numberField,
}

const EFFECT_CLASSIFY_TIMEOUT: RecordSpec = {
  plugin: stringField,
  symbolId: stringField,
  timeoutMs: numberField,
}

const LSP_HINT_REJECTIONS: RecordSpec = {
  unparseableHover: numberField,
  ownerClassNotFound: numberField,
  memberNotFound: numberField,
  kindMismatch: numberField,
  targetDropped: numberField,
}

const LSP_ENRICHMENT_STATS: RecordSpec = {
  enabled: booleanField,
  filesEnriched: numberField,
  filesFellBack: numberField,
  requestsIssued: numberField,
  requestsTimedOut: numberField,
  requestsFailed: numberField,
  languagesDisabled: stringArrayField,
  hintsProduced: optional(numberField),
  hintsConsumed: optional(numberField),
  hintsRejected: optional(record(LSP_HINT_REJECTIONS)),
}

const UNRESOLVED_CALL_BUCKETS: RecordSpec = {
  localScope: numberField,
  external: numberField,
  dynamic: numberField,
  ambiguous: numberField,
  noMatch: numberField,
}

const CALL_RESOLUTION_STATS: RecordSpec = {
  totalCalls: numberField,
  resolvedCalls: numberField,
  unresolved: record(UNRESOLVED_CALL_BUCKETS),
}

const SKIPPED_FILE: RecordSpec = {
  path: stringField,
  reason: stringField,
}

const STATS: RecordSpec = {
  totalFiles: numberField,
  parsedFiles: numberField,
  keptSymbols: numberField,
  droppedSymbols: numberField,
  effectPropagation: record(EFFECT_PROPAGATION_STATS),
  effectClassifyTimeouts: optional(recordArray(EFFECT_CLASSIFY_TIMEOUT)),
  lspEnrichment: optional(record(LSP_ENRICHMENT_STATS)),
  callResolution: optional(record(CALL_RESOLUTION_STATS)),
  skippedFiles: optional(recordArray(SKIPPED_FILE)),
}

const DOCUMENT: RecordSpec = {
  $schema: stringField,
  generatedAt: optional(stringField),
  generator: record(GENERATOR),
  workspace: record(WORKSPACE),
  components: recordArray(COMPONENT),
  symbols: recordArray(SYMBOL),
  dependencies: recordArray(DEPENDENCY),
  stats: record(STATS),
}

/**
 * The spec, exported for the drift test that compares it against `schema/aburi.ir.v1.json`.
 * Keyed by the schema's `$defs` name, with `$` for the root, so a `required` entry with no
 * line here fails that test rather than being discovered later by a `TypeError`.
 */
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

/**
 * The subject a breach at the top level of the Document is attributed to. Exported because
 * `@aburi/diff` prefixes every subject with the side it came from and has to recognise the
 * root to write `baseIR` rather than `baseIR.document`; a hand-copied literal there would go
 * quietly wrong if this were renamed.
 */
export const DOCUMENT_SUBJECT = "document"

function violation(subject: string, message: string): IntegrityViolation {
  // The subject names the record, the message names the field inside it, at every depth:
  // `symbols[0]` / `"name" is absent`, `document` / `"workspace" is absent`. Putting the
  // field in the subject at the top level and in the message everywhere else would make the
  // two halves mean different things depending on how deep the breach happened to be.
  return { invariant: 20, subject: subject.replace(`${DOCUMENT_SUBJECT}.`, ""), message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Name a value the way an error message should. `NaN` and `Infinity` get their own answer:
 * `typeof NaN` is `"number"`, so the default would report `is a number, not a finite number`.
 */
function describe(value: unknown): string {
  if (value === undefined) return "absent"
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "number" && !Number.isFinite(value)) return String(value)
  return `a ${typeof value}`
}
