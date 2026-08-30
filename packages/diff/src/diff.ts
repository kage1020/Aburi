import {
  checkDocumentShape,
  DOCUMENT_SUBJECT,
  reconstructCallEdgesFromIR,
  type SerializeOptions,
  serializeCanonical,
} from "@aburi/core"
import type {
  DiffResult,
  IR,
  IRRef,
  NotComparedFile,
  RelativePath,
  SkipReason,
  Summary,
  SymbolChange,
} from "@aburi/types"
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

const DIFF_SCHEMA = "https://aburi.kage1020.com/schema/aburi.diff.v1.json"

/**
 * The two counters `buildDiff` always writes, narrowed off `Summary`'s optionals.
 *
 * They are optional on the wire so a diff written before they existed stays valid, and that
 * optionality is about *documents*, not about this function — a caller holding a value it just
 * built should not have to re-decide what "absent" would have meant. Same reason
 * `diffDependencies` declares its `unknown` array present.
 */
interface UnknownCounters {
  unknown: number
  depsUnknown: number
}

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
export function buildDiff(
  input: DiffInput,
): DiffResult & { notCompared: NotComparedFile[]; summary: Summary & UnknownCounters } {
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

  // Typed with the two counters present. They are optional on the wire, but this function
  // writes both on every diff, and the local type is what carries that from here to the
  // return without a cast.
  const summary: Summary & UnknownCounters = {
    unknown: 0,
    depsUnknown: 0,
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
  // Counted locally and assigned once below, where the other totals are, so the increment
  // sites do not have to reason about a counter that is optional on the wire.
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
    notCompared: filesNeitherSideRead(lostByBase, lostByHead),
  }
}

/**
 * Paths both documents record as never analysed, with each side's own reason.
 *
 * This is the loss `unknown` cannot describe. That status is derived from the matcher's
 * leftovers — a Symbol one document holds and the other lacks — and a file skipped on both
 * sides contributes Symbols to neither, so it leaves no leftover to classify and the whole
 * document falls silent about it. Silence is the one thing it must not do here: a diff with
 * nothing to say about a path is exactly what a diff that compared it and found it unchanged
 * looks like.
 *
 * The intersection, not the union. A one-sided loss has leftovers on the other side and is
 * reported as `unknown` there; listing it here as well would count one loss twice, in two
 * vocabularies that mean different things.
 *
 * Always returns an array, empty included. Optionality in the schema covers documents written
 * before the field existed, and no arithmetic elsewhere in a diff would let a reader tell that
 * case from a run that missed nothing (docs/design/diff-algorithm.md §10.1).
 */
function filesNeitherSideRead(
  lostByBase: ReadonlyMap<RelativePath, SkipReason>,
  lostByHead: ReadonlyMap<RelativePath, SkipReason>,
): NotComparedFile[] {
  const both: NotComparedFile[] = []
  for (const [path, baseReason] of lostByBase) {
    const headReason = lostByHead.get(path)
    if (headReason === undefined) continue
    both.push({ path, baseReason, headReason })
  }
  return both.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
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
 * A collection `buildDiff` keys by identity, and refuses a repeat in. Reporting order is the
 * order of this array, base side before head side.
 *
 * The identity scan also refuses an entry that is not an object or whose identity fields are
 * not strings, and for the three collections here the shape gate has established both before
 * it runs. That is not free for a fourth: the gate covers what `aburi.ir.v1` declares, so a
 * collection added here and not there would reach the scan with those guards live again.
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
 * The three things `buildDiff` needs before stage 1 runs: a Document of the shape the schema
 * requires, a `$schema` that names something, and identities it can key on. diff-algorithm.md
 * §3.7 states the third and why it is checked here as well as at extraction time.
 *
 * The first is `checkDocumentShape` — invariant #20, and only #20. `buildDiff` is public API,
 * so an IR a caller assembled in memory arrives having passed nothing, and every field the
 * diff dereferences used to crash it with a `TypeError` that named neither the record nor the
 * field: `fingerprint` and `source` in `classifyStatus`, the four array fields in
 * `computeSymbolDelta`, `components[].roots` in `diffComponents`, `stats` in
 * `dependencySideView`. That list is the shape of the class rather than the whole of it — it
 * is one matcher change away from being out of date, which is the argument for a gate that is
 * not scoped to it. `integrity-shape.ts` makes that argument for itself and names this
 * consumer: a scope that moved with the matcher would leave a caller's IR conditionally valid.
 *
 * The second is this function's own requirement rather than the schema's, which requires only
 * that `$schema` is a string: two Documents that both say `""` agree with each other, so
 * `ensureSchemasAgree` would never fire on the pair. It is worded the way the gate words a
 * breach so one code does not come back in two shapes.
 *
 * It is equally deliberately not the semantic invariants. Those are statements about a
 * Document whose answer the diff does not depend on — an unsorted `symbols[]` diffs correctly,
 * because stage 1 keys by id — so running them would withhold an answer the matcher can give.
 * It also means `aburi diff`, which already ran the full checker in `readIR`, re-pays only the
 * structural walk.
 */
function assertDiffable(ir: IR, name: IRSide): void {
  const violations = checkDocumentShape(ir)
  const first = violations[0]
  if (first !== undefined) {
    // The subject names the record and the message names the field inside it, which is the
    // arrangement `checkDocumentShape` writes at every depth. Adopted rather than reworded so
    // the two gates cannot describe the same breach two ways. `DOCUMENT_SUBJECT` is its name
    // for the root, and the side already says which document this is.
    const subject = sidedSubject(name, first.subject)
    // The message quotes the first breach and counts the rest; `violations` carries all of
    // them, because a caller repairing a hand-assembled Document should not have to run the
    // diff once per field to find out what else is wrong.
    const rest = violations.length - 1
    const more = rest > 0 ? ` (and ${rest} more)` : ""
    throw new DiffError(`${subject}: ${first.message}${more}.`, {
      code: "ir-shape-invalid",
      value: subject,
      violations: violations.map((v) => ({ ...v, subject: sidedSubject(name, v.subject) })),
    })
  }
  if (ir.$schema.length === 0) {
    throw shapeError(name, `${name}: "$schema" is empty, not a schema URL.`)
  }
  for (const collection of IDENTIFIED_COLLECTIONS) {
    assertUniqueIdentity(ir[collection.field], `${name}.${collection.field}`, collection)
  }
}

/**
 * A shape violation's subject, prefixed with the side it came from. The prefix is what the
 * whole array needs and the message only shows for one of them — a caller reading
 * `violations` on a two-sided failure would otherwise get `symbols[0]` twice with nothing to
 * tell the documents apart.
 */
function sidedSubject(name: IRSide, subject: string): string {
  return subject === DOCUMENT_SUBJECT ? name : `${name}.${subject}`
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
 * The identity fields of one entry, read as strings.
 *
 * Three guards in this pass have no live path today — the array check in
 * `assertUniqueIdentity`, and the object and string checks below — because the shape gate
 * runs first and establishes all three for `symbols`, `components` and `dependencies`.
 * `describeValue` is theirs alone and so is dead with them. Measured: disabling all three
 * leaves this package's suite green.
 *
 * They stay because what makes them dead is the *contents* of `IDENTIFIED_COLLECTIONS`
 * matching what `aburi.ir.v1` declares, not anything about this file — a fourth collection
 * added to that array and not to the schema puts them back on the live path, silently.
 *
 * What they used to buy is now bought earlier: a Symbol carrying no `id` had nothing to
 * collide with, passed, and derived a Slice anchored on `undefined` several stages later —
 * which `assertSliceRecordInvariant` reports as `slice-invariant-violated`, the one code the
 * CLI presents as a bug in Aburi rather than in the caller's IR.
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
