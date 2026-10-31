import type { DiffResult } from "@aburi/types"
import { counted, inlineCode } from "../format"
import { renderComponentChanges } from "./component-changes"
import { renderDependencyChanges } from "./dependency-changes"
import {
  renderAdded,
  renderChangedList,
  renderDroppedToggled,
  renderMoved,
  renderMovedChanged,
  renderNotCompared,
  renderRemoved,
  renderSyntaxOnly,
  renderUnknown,
} from "./entries"
import {
  indexChanged,
  indexConfidence,
  indexMoved,
  indexRemoved,
  indexSymbols,
  indexUnknown,
} from "./names-only"
import { entrySymbol, partition } from "./partition"
import { assemble, foldedSection, plainSection, type Section } from "./size-cap"
import { renderSliceView } from "./slice-view"
import { inTestFile, renderTestFiles } from "./test-files"

export interface ProjectDiffOptions {
  readonly maxBytes?: number
  readonly fullReportLocation?: string
}

export function projectDiff(diff: DiffResult, options: ProjectDiffOptions = {}): string {
  const { maxBytes, fullReportLocation } = options
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes <= 0)) {
    throw new RangeError(
      `projectDiff: maxBytes must be a positive integer (got ${String(maxBytes)}).`,
    )
  }
  if (fullReportLocation !== undefined && /[\r\n]/.test(fullReportLocation)) {
    throw new RangeError(
      "projectDiff: fullReportLocation must not contain a line break; it is set inside a one-line note.",
    )
  }
  const heading = [
    `# Aburi diff: ${titleRef(diff.base.ref)}..${titleRef(diff.head.ref)}`,
    "",
    `**Summary**: ${summaryLine(diff)}`,
    "",
  ]

  const testChanges = diff.symbols.filter(inTestFile)
  const buckets = partition(diff.symbols.filter((change) => !inTestFile(change)))
  const testIds = new Set(testChanges.map((change) => entrySymbol(change).id))
  // A Slice with no members is left for the Slice View to refuse.
  const slices = diff.slices.filter(
    ({ members }) => members.length === 0 || members.some((id) => !testIds.has(id)),
  )
  const sections = [
    plainSection(
      "## ⚠ API changes",
      renderChangedList(buckets.apiChanged),
      indexChanged(buckets.apiChanged),
    ),
    plainSection(
      "## 🔧 Logic changes",
      renderChangedList(buckets.logicOnly),
      indexChanged(buckets.logicOnly),
    ),
    plainSection("## 🧵 Slice View", renderSliceView(slices, diff.symbols)),
    plainSection("## ➕ Added", renderAdded(buckets.added), indexSymbols(buckets.added)),
    plainSection("## ➖ Removed", renderRemoved(buckets.removed), indexRemoved(buckets.removed)),
    plainSection("## ❔ Unknown", renderUnknown(buckets.unknown), indexUnknown(buckets.unknown)),
    plainSection("## 🚫 Not compared", renderNotCompared(diff.notCompared ?? [])),
    plainSection(
      "## 🔀 Moved + Changed",
      renderMovedChanged(buckets.movedChanged),
      indexMoved(buckets.movedChanged),
    ),
    foldedSection(
      "## 🔀 Moved",
      renderMoved(buckets.moved),
      `${buckets.moved.length} moved (no semantic change)`,
    ),
    plainSection("## 🧱 Component changes", renderComponentChanges(diff)),
    plainSection("## 🔗 Dependency changes", renderDependencyChanges(diff)),
    foldedSection(
      "## 💧 Dropped changes",
      renderDroppedToggled(buckets.droppedToggled),
      counted(buckets.droppedToggled.length, "entry", "entries"),
    ),
    plainSection(
      "## 🎚 Confidence changes",
      renderChangedList(buckets.confidenceOnly),
      indexConfidence(buckets.confidenceOnly),
    ),
    foldedSection(
      "## 🎨 Syntax-only changes",
      renderSyntaxOnly(buckets.syntaxOnly),
      `${counted(buckets.syntaxOnly.length, "symbol", "symbols")} (implementation refactor only, no semantic change)`,
    ),
    foldedSection(
      "## 🧪 Test files",
      renderTestFiles(testChanges),
      counted(testChanges.length, "symbol in a test file", "symbols in test files"),
    ),
  ].filter((entry): entry is Section => entry !== null)

  return assemble(heading, sections, maxBytes, fullReportLocation)
}

export function projectDiffSummaryLine(diff: DiffResult): string {
  const summary = diff.summary
  return withUnknown(
    `+${summary.added} -${summary.removed} ~${summary.changed} ↔${summary.moved} ⤴${summary.movedChanged}`,
    diff,
  )
}

/** Hex admits no Markdown, and GitHub links a bare commit SHA, which it does not inside a span. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/

function titleRef(ref: string): string {
  return COMMIT_SHA.test(ref) ? ref : inlineCode(ref)
}

function summaryLine(diff: DiffResult): string {
  const summary = diff.summary
  const duplicates = summary.removedDuplicates ?? 0
  const removed =
    duplicates === 0 ? "removed" : `removed (${counted(duplicates, "duplicate", "duplicates")})`
  const line = withUnknown(
    `+${summary.added} added · -${summary.removed} ${removed} · ~${summary.changed} changed · ${summary.moved} moved · ${summary.movedChanged} moved+changed`,
    diff,
  )
  const inTests = diff.symbols.filter(inTestFile).length
  return inTests === 0 ? line : `${line} · ${inTests} in test files`
}

function withUnknown(line: string, diff: DiffResult): string {
  const unknown = diff.summary.unknown ?? 0
  return unknown === 0 ? line : `${line} · ?${unknown} unknown`
}
