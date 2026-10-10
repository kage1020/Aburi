import type { DiffResult } from "@aburi/types"
import { renderComponentChanges } from "./component-changes"
import { renderDependencyChanges } from "./dependency-changes"
import {
  renderAddedRemoved,
  renderChangedList,
  renderDroppedToggled,
  renderMoved,
  renderMovedChanged,
  renderNotCompared,
  renderSyntaxOnly,
  renderUnknown,
} from "./entries"
import {
  indexChanged,
  indexConfidence,
  indexMovedChanged,
  indexSymbols,
  indexUnknown,
} from "./names-only"
import { partition } from "./partition"
import { assemble, foldedSection, plainSection, type Section } from "./size-cap"
import { renderSliceView } from "./slice-view"

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
    `# Aburi diff: ${diff.base.ref}..${diff.head.ref}`,
    "",
    `**Summary**: ${summaryLine(diff)}`,
    "",
  ]

  const buckets = partition(diff.symbols)
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
    plainSection("## 🧵 Slice View", renderSliceView(diff.slices, diff.symbols)),
    plainSection("## ➕ Added", renderAddedRemoved(buckets.added), indexSymbols(buckets.added)),
    plainSection(
      "## ➖ Removed",
      renderAddedRemoved(buckets.removed),
      indexSymbols(buckets.removed),
    ),
    plainSection("## ❔ Unknown", renderUnknown(buckets.unknown), indexUnknown(buckets.unknown)),
    plainSection("## 🚫 Not compared", renderNotCompared(diff.notCompared ?? [])),
    plainSection(
      "## 🔀 Moved + Changed",
      renderMovedChanged(buckets.movedChanged),
      indexMovedChanged(buckets.movedChanged),
    ),
    foldedSection("## 🔀 Moved", renderMoved(buckets.moved), buckets.moved.length),
    plainSection("## 🧱 Component changes", renderComponentChanges(diff)),
    plainSection("## 🔗 Dependency changes", renderDependencyChanges(diff)),
    foldedSection(
      "## 💧 Dropped changes",
      renderDroppedToggled(buckets.droppedToggled),
      buckets.droppedToggled.length,
    ),
    plainSection(
      "## 🎚 Confidence changes",
      renderChangedList(buckets.confidenceOnly),
      indexConfidence(buckets.confidenceOnly),
    ),
    foldedSection(
      "## 🎨 Syntax-only changes",
      renderSyntaxOnly(buckets.syntaxOnly),
      buckets.syntaxOnly.length,
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

function summaryLine(diff: DiffResult): string {
  const summary = diff.summary
  return withUnknown(
    `+${summary.added} added · -${summary.removed} removed · ~${summary.changed} changed · ${summary.moved} moved · ${summary.movedChanged} moved+changed`,
    diff,
  )
}

function withUnknown(line: string, diff: DiffResult): string {
  const unknown = diff.summary.unknown ?? 0
  return unknown === 0 ? line : `${line} · ?${unknown} unknown`
}
