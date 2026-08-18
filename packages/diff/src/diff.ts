import { reconstructCallEdgesFromIR, type SerializeOptions, serializeCanonical } from "@aburi/core"
import type { DiffResult, IR, IRRef, Summary, SymbolChange } from "@aburi/types"
import {
  DEPENDENCY_IDENTITY_FIELDS,
  dependencyIdentity,
  dependencySideView,
  diffComponents,
  diffDependencies,
} from "./components"
import { computeSymbolDelta, type DeltaOptions } from "./delta"
import { DiffError } from "./errors"
import {
  type GitRenameMap,
  matchStageDroppedWeak,
  matchStageGitRename,
  matchStageId,
  matchStageLogicFingerprint,
  matchStageNameSignature,
  type SymbolPair,
} from "./match"
import { computeSlices } from "./slice"
import { classifyStatus, dropDirection } from "./status"

const DIFF_SCHEMA = "https://aburi.dev/schema/aburi.diff.v1.json"

export interface DiffInput {
  baseIR: IR
  headIR: IR
  /** IR reference metadata (git ref / file path) for provenance. */
  base: IRRef
  head: IRRef
  /** Generator record for the diff output. Defaults to `{name: "aburi", version: "0.0.0"}`. */
  generator?: { name: string; version: string }
  /** Optional stage-2 rename table. When null/undefined stage 2 is skipped. */
  gitRenames?: GitRenameMap | null
  /** Passed through to computeSymbolDelta (§5.2.1 line fuzz). */
  delta?: DeltaOptions
}

const DEFAULT_GENERATOR = { name: "aburi", version: "0.0.0" }

/**
 * Top-level entry: run the 5-stage matcher, classify each pair, produce array deltas,
 * fold in Component / Dependency diffs, and assemble the `aburi.diff.v1` JSON projection.
 * The function is pure; write-to-disk is delegated to `writeCanonicalDiff` so callers can
 * pipe the result through additional steps (Markdown projection, `--fail-on` gate) before
 * serialisation.
 */
export function buildDiff(input: DiffInput): DiffResult {
  assertDiffable(input.baseIR, "baseIR")
  assertDiffable(input.headIR, "headIR")
  ensureSchemasAgree(input.baseIR, input.headIR)
  const stage1 = matchStageId(input.baseIR.symbols, input.headIR.symbols)
  const stage2 = matchStageGitRename(
    stage1.remainingBase,
    stage1.remainingHead,
    input.gitRenames ?? null,
  )
  const stage3 = matchStageLogicFingerprint(stage2.remainingBase, stage2.remainingHead)
  const stage4 = matchStageNameSignature(stage3.remainingBase, stage3.remainingHead)
  const stage4_5 = matchStageDroppedWeak(stage4.remainingBase, stage4.remainingHead)

  const pairs: SymbolPair[] = [
    ...stage1.matched,
    ...stage2.matched,
    ...stage3.matched,
    ...stage4.matched,
    ...stage4_5.matched,
  ]

  const summary: Summary = {
    added: 0,
    removed: 0,
    moved: 0,
    movedChanged: 0,
    changed: 0,
    droppedToggled: 0,
    unchanged: 0,
    droppedAdded: 0,
    droppedRemoved: 0,
    componentsAdded: 0,
    componentsRemoved: 0,
    componentsChanged: 0,
    depsAdded: 0,
    depsRemoved: 0,
  }
  // Counted locally: `Summary.unknown` is optional so a diff written before the counter
  // existed stays schema-valid, and `summary.unknown++` on an optional number does not
  // type-check. Assigned once, below, where the other totals are.
  let unknown = 0

  const symbols: SymbolChange[] = []
  for (const pair of pairs) {
    const status = classifyStatus(pair.base, pair.head)
    if (status === "unchanged") {
      summary.unchanged++
      continue
    }
    if (status === "dropped-toggled") {
      summary.droppedToggled++
      symbols.push({
        status: "dropped-toggled",
        before: pair.base,
        after: pair.head,
        direction: dropDirection(pair.head),
      })
      continue
    }
    if (status === "moved") {
      summary.moved++
      symbols.push({
        status: "moved",
        before: pair.base,
        after: pair.head,
        rationale: pair.rationale,
      })
      continue
    }
    if (status === "changed") {
      summary.changed++
      symbols.push({
        status: "changed",
        before: pair.base,
        after: pair.head,
        delta: computeSymbolDelta(pair.base, pair.head, input.delta ?? {}),
      })
      continue
    }
    // moved+changed
    summary.movedChanged++
    symbols.push({
      status: "moved+changed",
      before: pair.base,
      after: pair.head,
      rationale: pair.rationale,
      delta: computeSymbolDelta(pair.base, pair.head, input.delta ?? {}),
    })
  }

  const finalRemainingHead = stage4_5.remainingHead
  const finalRemainingBase = stage4_5.remainingBase

  // Read after the five matching stages, never before them. A Symbol that crossed files
  // between the two revisions is paired by stage 2, 3 or 4 and comes out `moved` or
  // `moved+changed`, whichever end of the move sits in the lost file — the other document
  // holds real evidence for it either way. Only the leftovers are absences, and only an
  // absence in a file that was never analysed is unexplained.
  //
  // The two loops below read opposite ends: a base leftover is looked up by the file it
  // came from, a head leftover by the file it arrived in. In both cases the question is the
  // same — did the document that lacks this Symbol ever read the file it is in?
  // One construction per side, shared with the Dependency diff below. The Symbol loops and
  // `diffDependencies` therefore read the same two maps rather than two answers to the same
  // question — which is what makes "a Symbol reported unknown and the edges it took with it
  // cannot disagree about which file went missing" structural instead of aspirational.
  const baseSide = dependencySideView(input.baseIR)
  const headSide = dependencySideView(input.headIR)
  const lostByHead = headSide.lostFiles
  const lostByBase = baseSide.lostFiles

  for (const h of finalRemainingHead) {
    if (h.dropped) {
      summary.droppedAdded++
      continue
    }
    const reason = lostByBase.get(h.source.file)
    if (reason !== undefined) {
      unknown++
      symbols.push({ status: "unknown", symbol: h, absentFrom: "base", reason })
      continue
    }
    summary.added++
    symbols.push({ status: "added", symbol: h })
  }
  for (const b of finalRemainingBase) {
    if (b.dropped) {
      summary.droppedRemoved++
      continue
    }
    const reason = lostByHead.get(b.source.file)
    if (reason !== undefined) {
      unknown++
      symbols.push({ status: "unknown", symbol: b, absentFrom: "head", reason })
      continue
    }
    summary.removed++
    symbols.push({ status: "removed", symbol: b })
  }

  const components = diffComponents(input.baseIR.components, input.headIR.components)
  summary.componentsAdded = components.added.length
  summary.componentsRemoved = components.removed.length
  summary.componentsChanged = components.changed.length

  const dependencies = diffDependencies(input.baseIR.dependencies, input.headIR.dependencies, {
    base: baseSide,
    head: headSide,
  })
  summary.depsAdded = dependencies.added.length
  summary.depsRemoved = dependencies.removed.length
  // No `?? 0`: `diffDependencies` declares `unknown` present when it is given side views, so
  // absorbing an absence here would launder a mis-wiring into a confident `depsUnknown: 0`.
  summary.depsUnknown = dependencies.unknown.length
  summary.unknown = unknown

  symbols.sort(compareSymbolChange)

  // Slice View clustering (docs/design/slice-view.md §2). Runs after status /
  // delta computation and before Markdown projection. Consumes the resolved
  // CallEdge[] reconstructed from each IR — §5.4 requires only resolved edges,
  // never `Symbol.calls[]` directly. Emits `slices[]` unconditionally (§11.2);
  // the Markdown side omits the section when the array is empty (§12.5).
  const slices = computeSlices({
    changes: symbols,
    baseCallEdges: reconstructCallEdgesFromIR(input.baseIR),
    headCallEdges: reconstructCallEdgesFromIR(input.headIR),
  })

  return {
    $schema: DIFF_SCHEMA,
    generator: input.generator ?? DEFAULT_GENERATOR,
    base: input.base,
    head: input.head,
    summary,
    symbols,
    components,
    dependencies,
    slices,
  }
}

/** §9.1 — refuse to diff across schema versions. */
function ensureSchemasAgree(base: IR, head: IR): void {
  if (base.$schema !== head.$schema) {
    throw new DiffError(
      `Base IR schema "${base.$schema}" does not match head IR schema "${head.$schema}"; a diff across schema versions is not supported.`,
      { code: "schema-mismatch", value: base.$schema },
    )
  }
}

/** Which of the two inputs a message is about. */
type IRSide = "baseIR" | "headIR"

/**
 * A collection `buildDiff` keys by identity. One descriptor drives both halves of the
 * entry-point check — that the entries are objects carrying string identity fields, and that
 * no identity repeats — so the two cannot come to describe different collections, and a
 * fourth entry added here is guarded by both or by neither. Reporting order is the order of
 * this array, base side before head side.
 */
interface IdentifiedCollection {
  readonly field: "symbols" | "components" | "dependencies"
  /** The fields identity is read from, in the order `keyOf` receives them. */
  readonly identityFields: readonly string[]
  /** Join them the way the diff itself keys on them, or the check guards nothing. */
  readonly keyOf: (parts: readonly string[]) => string
  /** How a message names the repeated value. */
  readonly noun: string
  /** The repeated value as the IR spells it; also what `DiffError.value` carries. */
  readonly show: (parts: readonly string[]) => string
  /** What the diff does with a repeat, and the invariant that forbids it. */
  readonly consequence: string
}

/** Identity is a single field, so joining the one-member tuple is joining nothing. */
const soleField = (parts: readonly string[]): string => parts.join("")

const IDENTIFIED_COLLECTIONS: readonly IdentifiedCollection[] = [
  {
    field: "symbols",
    identityFields: ["id"],
    keyOf: soleField,
    noun: "id",
    show: soleField,
    consequence:
      "stage 1 pairs Symbols by id and every later stage tracks the base Symbols it has " +
      "consumed by id, so a repeat leaves one entry out of the diff entirely or classifies " +
      "its counterpart twice (ir-schema.md §14 #1)",
  },
  {
    field: "components",
    identityFields: ["id"],
    keyOf: soleField,
    noun: "id",
    show: soleField,
    consequence:
      "Component identity is the id, so a repeat hides one entry and can report a change " +
      "the two revisions do not contain (ir-schema.md §14 #2)",
  },
  {
    field: "dependencies",
    identityFields: DEPENDENCY_IDENTITY_FIELDS,
    keyOf: dependencyIdentity,
    noun: "(from, to, via) triple",
    show: (parts) => `(${parts.join(", ")})`,
    consequence:
      "direction and effect are deliberately outside Dependency identity (§6.2), so a " +
      "repeat surfaces as an added + removed pair no reader can tell from a real flip " +
      "(ir-schema.md §14 #13)",
  },
]

/**
 * The two things `buildDiff` needs before stage 1 runs: a Document it can walk, and
 * identities it can key on. diff-algorithm.md §3.7 states the second and why it is checked
 * here as well as at extraction time.
 *
 * Neither half is a full schema validation. A Symbol that reaches stage 1 is an object with
 * a string `id`, because the identity scan reads that much; nothing checks it carries a
 * `fingerprint`, which is `checkIRIntegrity` #20's job and runs when the CLI reads an IR off
 * disk. What this does buy is that a malformed collection is named — `symbols: undefined`
 * used to surface as `TypeError: undefined is not iterable` and `symbols: [null]` as
 * `TypeError: Cannot read properties of null (reading 'id')`, both from inside
 * `matchStageId`, with neither the collection nor the index named.
 */
function assertDiffable(ir: IR, name: IRSide): void {
  if (ir === null || typeof ir !== "object") {
    throw shapeError(name, `${name} must be an IR object; got ${describeValue(ir)}.`)
  }
  if (typeof ir.$schema !== "string" || ir.$schema.length === 0) {
    throw shapeError(`${name}.$schema`, `${name}.$schema must be a non-empty schema URL.`)
  }
  for (const collection of IDENTIFIED_COLLECTIONS) {
    assertUniqueIdentity(ir[collection.field], `${name}.${collection.field}`, collection)
  }
}

function assertUniqueIdentity(
  entries: unknown,
  subject: string,
  collection: IdentifiedCollection,
): void {
  if (!Array.isArray(entries)) {
    throw shapeError(subject, `${subject} must be an array.`)
  }
  const firstSeen = new Map<string, number>()
  for (const [index, entry] of entries.entries()) {
    const entrySubject = `${subject}[${index}]`
    const parts = identityFieldsOf(entry, entrySubject, collection)
    const key = collection.keyOf(parts)
    const first = firstSeen.get(key)
    if (first === undefined) {
      firstSeen.set(key, index)
      continue
    }
    const shown = collection.show(parts)
    throw new DiffError(
      `${entrySubject} repeats the ${collection.noun} "${shown}" first seen at index ` +
        `${first}; ${collection.consequence}.`,
      { code: "ir-identity-collision", value: shown },
    )
  }
}

/**
 * The identity fields of one entry, established as strings on the way out. Reading them is
 * what forces the check: without it a Symbol carrying no `id` has nothing to collide with,
 * passes, and derives a Slice anchored on `undefined` several stages later — which
 * `assertSliceRecordInvariant` reports as `slice-invariant-violated`, the one code the CLI
 * presents as a bug in Aburi rather than in the caller's IR.
 */
function identityFieldsOf(
  entry: unknown,
  subject: string,
  collection: IdentifiedCollection,
): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw shapeError(subject, `${subject} must be an object; got ${describeValue(entry)}.`)
  }
  const parts: string[] = []
  for (const field of collection.identityFields) {
    const value = (entry as Record<string, unknown>)[field]
    if (typeof value !== "string") {
      throw shapeError(
        `${subject}.${field}`,
        `${subject}.${field} must be a string; got ${describeValue(value)}.`,
      )
    }
    parts.push(value)
  }
  return parts
}

function shapeError(subject: string, message: string): DiffError {
  return new DiffError(message, { code: "ir-shape-invalid", value: subject })
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `a ${typeof value}`
}

/**
 * Deterministic ordering of the `symbols[]` output:
 * 1. by status (alphabetical) — pins added/changed/moved sections
 * 2. by the "reference" id (`after` for change/move/toggle, otherwise `symbol`)
 *
 * The result is stable byte-for-byte for equal inputs, matching the canonicalisation
 * guarantee the diff JSON must uphold when persisted to `out/diff.json`.
 */
function compareSymbolChange(a: SymbolChange, b: SymbolChange): number {
  if (a.status !== b.status) return a.status < b.status ? -1 : 1
  const idA = referenceId(a)
  const idB = referenceId(b)
  return idA < idB ? -1 : idA > idB ? 1 : 0
}

function referenceId(change: SymbolChange): string {
  if (change.status === "added" || change.status === "removed" || change.status === "unknown") {
    return change.symbol.id
  }
  return change.after.id
}

/**
 * The files a document's scan never analysed, by path, with why.
 *
 * `stats.skippedFiles` is Class B: absent means the writer predates the field, not that
 * nothing was lost. An empty map is the honest answer either way — with no enumeration
 * there is no absence this function can explain, and guessing from
 * `totalFiles > parsedFiles` would attach a reason to whichever Symbols happened to be
 * missing. The CLI says so on stderr instead; a diff cannot invent the list.
 */
/**
 * Byte-deterministic serialiser for a DiffResult. Delegates to `@aburi/core`
 * `serializeCanonical` so the sort order, NFC normalisation, and codepoint key sort are
 * shared with the IR side.
 */
export function writeCanonicalDiff(diff: DiffResult, options: SerializeOptions = {}): string {
  return serializeCanonical(diff, options)
}
