import {
  checkDocumentShape,
  compareCodeUnit,
  DOCUMENT_SUBJECT,
  reconstructCallEdgesFromIR,
  type SerializeOptions,
  serializeCanonical,
} from "@aburi/core"
import type {
  DiffResult,
  DiffSkippedFile,
  IR,
  IRRef,
  IRSymbol,
  NotComparedFile,
  Summary,
  SymbolChange,
  SymbolUnknown,
} from "@aburi/types"
import {
  type AbsentSide,
  DEPENDENCY_IDENTITY_FIELDS,
  dependencyIdentity,
  dependencySideView,
  diffComponents,
  diffDependencies,
  type LossSides,
  lostCounterpart,
  lostCounterparts,
  renameDirections,
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
  gitRenames?: GitRenameMap | null
  /** Passed through to computeSymbolDelta. */
  delta?: DeltaOptions
}

const DEFAULT_GENERATOR = { name: "aburi", version: "0.0.0" }

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

  const sides: LossSides = {
    base: dependencySideView(input.baseIR),
    head: dependencySideView(input.headIR),
    renames: renameDirections(input.gitRenames ?? null),
  }

  for (const headSymbol of stageDroppedWeak.remainingHead) {
    if (headSymbol.dropped) {
      summary.droppedAdded++
      continue
    }
    const lost = lostCounterpart(headSymbol.source.file, "base", sides)
    if (lost !== undefined) {
      unknown++
      symbols.push(unknownSymbol(headSymbol, "base", lost))
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
    const lost = lostCounterpart(baseSymbol.source.file, "head", sides)
    if (lost !== undefined) {
      unknown++
      symbols.push(unknownSymbol(baseSymbol, "head", lost))
      continue
    }
    summary.removed++
    symbols.push({ status: "removed", symbol: baseSymbol })
  }

  const components = diffComponents(input.baseIR.components, input.headIR.components)
  summary.componentsAdded = components.added.length
  summary.componentsRemoved = components.removed.length
  summary.componentsChanged = components.changed.length

  const dependencies = diffDependencies(input.baseIR.dependencies, input.headIR.dependencies, sides)
  summary.depsAdded = dependencies.added.length
  summary.depsRemoved = dependencies.removed.length
  summary.depsUnknown = dependencies.unknown.length
  summary.unknown = unknown

  symbols.sort(compareSymbolChange)

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
    notCompared: filesNeitherSideRead(sides),
  }
}

function unknownSymbol(
  symbol: IRSymbol,
  absentFrom: AbsentSide,
  lost: DiffSkippedFile,
): SymbolUnknown {
  return {
    status: "unknown",
    symbol,
    absentFrom,
    reason: lost.reason,
    ...(lost.path === symbol.source.file ? {} : { lostPath: lost.path }),
  }
}

function filesNeitherSideRead(sides: LossSides): NotComparedFile[] {
  const both: NotComparedFile[] = []
  for (const [basePath, baseReason] of sides.base.lostFiles) {
    for (const lost of lostCounterparts(basePath, "head", sides)) {
      both.push({
        path: lost.path,
        ...(lost.path === basePath ? {} : { basePath }),
        baseReason,
        headReason: lost.reason,
      })
    }
  }
  return both.sort(compareNotCompared)
}

const compareNotCompared = (a: NotComparedFile, b: NotComparedFile): number =>
  compareCodeUnit(a.path, b.path) || compareCodeUnit(a.basePath ?? a.path, b.basePath ?? b.path)

/** Refuse to diff across schema versions. */
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

function assertDiffable(ir: IR, name: IRSide): void {
  const violations = checkDocumentShape(ir)
  const first = violations[0]
  if (first !== undefined) {
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

function compareSymbolChange(a: SymbolChange, b: SymbolChange): number {
  return (
    compareCodeUnit(a.status, b.status) ||
    compareCodeUnit(representativeSymbol(a).id, representativeSymbol(b).id)
  )
}

export function writeCanonicalDiff(diff: DiffResult, options: SerializeOptions = {}): string {
  return serializeCanonical(diff, options)
}
