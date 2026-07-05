import { type SerializeOptions, serializeCanonical } from "@aburi/core"
import type { DiffResult, IR, IRRef, Summary, SymbolChange } from "@aburi/types"
import { diffComponents, diffDependencies } from "./components"
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
  assertIRShape(input.baseIR, "baseIR")
  assertIRShape(input.headIR, "headIR")
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

  for (const h of finalRemainingHead) {
    if (h.dropped) summary.droppedAdded++
    else {
      summary.added++
      symbols.push({ status: "added", symbol: h })
    }
  }
  for (const b of finalRemainingBase) {
    if (b.dropped) summary.droppedRemoved++
    else {
      summary.removed++
      symbols.push({ status: "removed", symbol: b })
    }
  }

  const components = diffComponents(input.baseIR.components, input.headIR.components)
  summary.componentsAdded = components.added.length
  summary.componentsRemoved = components.removed.length
  summary.componentsChanged = components.changed.length

  const dependencies = diffDependencies(input.baseIR.dependencies, input.headIR.dependencies)
  summary.depsAdded = dependencies.added.length
  summary.depsRemoved = dependencies.removed.length

  symbols.sort(compareSymbolChange)

  return {
    $schema: DIFF_SCHEMA,
    generator: input.generator ?? DEFAULT_GENERATOR,
    base: input.base,
    head: input.head,
    summary,
    symbols,
    components,
    dependencies,
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

/**
 * Top-level shape check. Refuses to enter the 5-stage matcher when a caller hands in an
 * IR-shaped object that is missing one of the collections the matcher requires as an
 * array. Without this, a malformed `baseIR = { symbols: undefined, ... }` would crash
 * deep inside `matchStageId` with `TypeError: undefined is not iterable`, leaving the
 * root cause obscured. Not a full schema validation — just an entry-point smoke test.
 */
function assertIRShape(ir: IR, name: "baseIR" | "headIR"): void {
  if (ir === null || typeof ir !== "object") {
    throw new DiffError(`${name} must be an IR object; got ${typeof ir}.`, {
      code: "ir-shape-invalid",
      value: name,
    })
  }
  if (typeof ir.$schema !== "string" || ir.$schema.length === 0) {
    throw new DiffError(`${name}.$schema must be a non-empty schema URL.`, {
      code: "ir-shape-invalid",
      value: `${name}.$schema`,
    })
  }
  for (const field of ["symbols", "components", "dependencies"] as const) {
    if (!Array.isArray(ir[field])) {
      throw new DiffError(`${name}.${field} must be an array.`, {
        code: "ir-shape-invalid",
        value: `${name}.${field}`,
      })
    }
  }
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
  if (change.status === "added" || change.status === "removed") return change.symbol.id
  return change.after.id
}

/**
 * Byte-deterministic serialiser for a DiffResult. Delegates to `@aburi/core`
 * `serializeCanonical` so the sort order, NFC normalisation, and codepoint key sort are
 * shared with the IR side.
 */
export function writeCanonicalDiff(diff: DiffResult, options: SerializeOptions = {}): string {
  return serializeCanonical(diff, options)
}
