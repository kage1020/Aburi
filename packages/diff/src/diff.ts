import {
  checkDocumentShape,
  compareBy,
  compareCodeUnit,
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
import { classifyStatus, dropDirection, representativeSymbol } from "./status"

const DIFF_SCHEMA = "https://aburi.kage1020.com/schema/aburi.diff.v1.json"

/**
 * The two counters `buildDiff` always writes. They are optional on `Summary` only so a diff
 * written before they existed stays valid; a caller holding a freshly built value should not
 * have to re-decide what "absent" means.
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
  /** Passed through to computeSymbolDelta (line fuzz, diff-algorithm.md). */
  delta?: DeltaOptions
}

const DEFAULT_GENERATOR = { name: "aburi", version: "0.0.0" }

/**
 * Top-level entry: run the 5-stage matcher, classify each pair, produce array deltas,
 * fold in Component / Dependency diffs, and assemble the `aburi.diff.v1` JSON projection.
 * Pure; `writeCanonicalDiff` serialises, so callers can run the Markdown projection or the
 * `--fail-on` gate over the result first.
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
  const stageDroppedWeak = matchStageDroppedWeak(stage4.remainingBase, stage4.remainingHead)

  const pairs: SymbolPair[] = [
    ...stage1.matched,
    ...stage2.matched,
    ...stage3.matched,
    ...stage4.matched,
    ...stageDroppedWeak.matched,
  ]

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
    summary.movedChanged++
    symbols.push({
      status: "moved+changed",
      before: pair.base,
      after: pair.head,
      rationale: pair.rationale,
      delta: computeSymbolDelta(pair.base, pair.head, input.delta ?? {}),
    })
  }

  // Read after the matching stages: a Symbol that crossed files is paired by stage 2–4 and
  // comes out `moved`, so only a leftover is an absence, and only one in a file the other
  // document never analysed is unexplained. The Symbol loops and `diffDependencies` read the
  // same two side views, so a Symbol reported unknown and the edges it took with it cannot
  // disagree about which file went missing.
  const baseSide = dependencySideView(input.baseIR)
  const headSide = dependencySideView(input.headIR)
  const lostByHead = headSide.lostFiles
  const lostByBase = baseSide.lostFiles

  for (const headSymbol of stageDroppedWeak.remainingHead) {
    if (headSymbol.dropped) {
      summary.droppedAdded++
      continue
    }
    const reason = lostByBase.get(headSymbol.source.file)
    if (reason !== undefined) {
      unknown++
      symbols.push({ status: "unknown", symbol: headSymbol, absentFrom: "base", reason })
      continue
    }
    summary.added++
    symbols.push({ status: "added", symbol: headSymbol })
  }
  for (const baseSymbol of stageDroppedWeak.remainingBase) {
    if (baseSymbol.dropped) {
      summary.droppedRemoved++
      continue
    }
    const reason = lostByHead.get(baseSymbol.source.file)
    if (reason !== undefined) {
      unknown++
      symbols.push({ status: "unknown", symbol: baseSymbol, absentFrom: "head", reason })
      continue
    }
    summary.removed++
    symbols.push({ status: "removed", symbol: baseSymbol })
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

  // Slice View clustering (docs/design/slice-view.md), over the resolved call edges only —
  // never `Symbol.calls[]` directly. `slices[]` is emitted even when empty; the Markdown side
  // is what omits the section.
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
 * Paths both documents record as never analysed, with each side's reason. A file skipped on
 * both sides contributes Symbols to neither, so it leaves no leftover for `unknown` to
 * classify and the diff would otherwise fall silent about it — which is what a diff that
 * compared it and found it unchanged looks like. The intersection only: a one-sided loss is
 * already reported as `unknown` on the other side. Always an array, empty included
 * (docs/design/diff-algorithm.md).
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
  return both.sort(compareBy((file) => file.path))
}

/** Refuse to diff across schema versions (diff-algorithm.md). */
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
 * order of `IDENTIFIED_COLLECTIONS`, base side before head side. The shape gate has already
 * established that every entry is an object whose identity fields are strings.
 *
 * This pass used to re-establish that itself, with an array check, an object check and a
 * string check on every entry, kept on the argument that a fourth collection added here and
 * not to `aburi.ir.v1` would silently put them back on the live path. That argument was about
 * a version of `identityFields` that named its fields as strings and read them off an
 * `unknown` entry. It does not survive `identities`: a collection now supplies a typed
 * projection out of `IR`, so a field the schema does not declare is a field `IR` does not
 * have, and one that is not a string is not a `readonly string[]`. Both are compile errors at
 * the entry that introduces them rather than runtime guards waiting for one — which is why
 * the guards are gone and this note is here instead.
 */
interface IdentifiedCollection {
  readonly field: "symbols" | "components" | "dependencies"
  /** The identity fields of every entry, in the order `keyOf` receives them. */
  readonly identities: (ir: IR) => readonly (readonly string[])[]
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
    identities: (ir) => ir.symbols.map((symbol) => [symbol.id]),
    keyOf: soleField,
    noun: "id",
    show: soleField,
    consequence:
      "stage 1 pairs Symbols by id and every later stage tracks the base Symbols it has " +
      "consumed by id, so a repeat leaves one entry out of the diff entirely or classifies " +
      "its counterpart twice (ir-schema.md #1)",
  },
  {
    field: "components",
    identities: (ir) => ir.components.map((component) => [component.id]),
    keyOf: soleField,
    noun: "id",
    show: soleField,
    consequence:
      "Component identity is the id, so a repeat hides one entry and can report a change " +
      "the two revisions do not contain (ir-schema.md #2)",
  },
  {
    field: "dependencies",
    identities: (ir) =>
      ir.dependencies.map((dependency) =>
        DEPENDENCY_IDENTITY_FIELDS.map((field) => dependency[field]),
      ),
    keyOf: dependencyIdentity,
    noun: "(from, to, via) triple",
    show: (parts) => `(${parts.join(", ")})`,
    consequence:
      "direction and effect are deliberately outside Dependency identity " +
      "(diff-algorithm.md), so a " +
      "repeat surfaces as an added + removed pair no reader can tell from a real flip " +
      "(ir-schema.md #13)",
  },
]

/**
 * What `buildDiff` needs before stage 1 runs: a Document of the shape the schema requires
 * (`checkDocumentShape`, invariant #20 — `buildDiff` is public API, so an IR assembled in
 * memory arrives having passed nothing), a `$schema` that names something (two Documents
 * that both say `""` would agree with each other), and identities it can key on
 * (diff-algorithm.md). Deliberately not the semantic invariants: an unsorted
 * `symbols[]` diffs correctly, so refusing it would withhold an answer the matcher can give.
 */
function assertDiffable(ir: IR, name: IRSide): void {
  const violations = checkDocumentShape(ir)
  const first = violations[0]
  if (first !== undefined) {
    // The message quotes the first breach and counts the rest; `violations` carries all of
    // them so a caller repairing a hand-assembled Document does not run the diff once per field.
    const subject = sidedSubject(name, first.subject)
    const rest = violations.length - 1
    const more = rest > 0 ? ` (and ${rest} more)` : ""
    throw new DiffError(`${subject}: ${first.message}${more}.`, {
      code: "ir-shape-invalid",
      value: subject,
      violations: violations.map((v) => ({ ...v, subject: sidedSubject(name, v.subject) })),
    })
  }
  if (ir.$schema.length === 0) {
    throw new DiffError(`${name}: "$schema" is empty, not a schema URL.`, {
      code: "ir-shape-invalid",
      value: name,
    })
  }
  for (const collection of IDENTIFIED_COLLECTIONS) {
    assertUniqueIdentity(collection.identities(ir), `${name}.${collection.field}`, collection)
  }
}

/** A shape violation's subject prefixed with its side, so a two-sided failure is readable. */
function sidedSubject(name: IRSide, subject: string): string {
  return subject === DOCUMENT_SUBJECT ? name : `${name}.${subject}`
}

function assertUniqueIdentity(
  identities: readonly (readonly string[])[],
  subject: string,
  collection: IdentifiedCollection,
): void {
  const firstSeen = new Map<string, number>()
  for (const [index, parts] of identities.entries()) {
    const key = collection.keyOf(parts)
    const first = firstSeen.get(key)
    if (first === undefined) {
      firstSeen.set(key, index)
      continue
    }
    const shown = collection.show(parts)
    throw new DiffError(
      `${subject}[${index}] repeats the ${collection.noun} "${shown}" first seen at index ` +
        `${first}; ${collection.consequence}.`,
      { code: "ir-identity-collision", value: shown },
    )
  }
}

/**
 * Deterministic ordering of `symbols[]`: by status, then by the representative Symbol's id.
 * Byte-stable for equal inputs, which the canonical `out/diff.json` relies on.
 */
function compareSymbolChange(a: SymbolChange, b: SymbolChange): number {
  return (
    compareCodeUnit(a.status, b.status) ||
    compareCodeUnit(representativeSymbol(a).id, representativeSymbol(b).id)
  )
}

/**
 * Byte-deterministic serialiser for a DiffResult, sharing `@aburi/core`'s canonical sort
 * order, NFC normalisation and key sort with the IR side.
 */
export function writeCanonicalDiff(diff: DiffResult, options: SerializeOptions = {}): string {
  return serializeCanonical(diff, options)
}
