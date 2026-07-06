import type {
  DiffResult,
  Symbol as IRSymbol,
  SymbolChange,
  SymbolChanged,
  SymbolDelta,
  SymbolDroppedToggled,
  SymbolMoved,
  SymbolMovedChanged,
} from "@aburi/types"
import { renderSymbolBlock } from "./component"

/**
 * §6 — `out/diff.md`. Sections are emitted in the fixed importance order
 * (API 変更 → Syntax-only) and the bottom three are collapsed inside `<details>` so PR
 * comments stay reviewer-friendly. Empty sections are dropped entirely (§5.3 rule).
 */
export function projectDiff(diff: DiffResult): string {
  const lines: string[] = []
  lines.push(`# Aburi diff: ${diff.base.ref}..${diff.head.ref}`)
  lines.push("")
  lines.push(`**Summary**: ${summaryLine(diff)}`)
  lines.push("")

  const buckets = partition(diff.symbols)

  appendSection(lines, "## ⚠ API 変更", renderChangedList(buckets.apiChanged))
  appendSection(lines, "## 🔧 Logic 変更", renderChangedList(buckets.logicOnly))
  appendSection(lines, "## ➕ Added", renderAddedRemoved(buckets.added))
  appendSection(lines, "## ➖ Removed", renderAddedRemoved(buckets.removed))
  appendSection(lines, "## 🔀 Moved + Changed", renderMovedChanged(buckets.movedChanged))
  appendFolded(lines, "## 🔀 Moved", renderMoved(buckets.moved))
  appendSection(lines, "## 🧱 Component changes", renderComponentChanges(diff))
  appendSection(lines, "## 🔗 Dependency changes", renderDependencyChanges(diff))
  appendFolded(lines, "## 💧 Dropped 変動", renderDroppedToggled(buckets.droppedToggled))
  appendFolded(lines, "## 🎨 Syntax-only 変更", renderSyntaxOnly(buckets.syntaxOnly))

  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  )
}

/** §6.3 — one-line CLI stdout summary. */
export function projectDiffSummaryLine(diff: DiffResult): string {
  const s = diff.summary
  return `+${s.added} -${s.removed} ~${s.changed} ↔${s.moved} ⤴${s.movedChanged}`
}

function summaryLine(diff: DiffResult): string {
  const s = diff.summary
  return `+${s.added} added · -${s.removed} removed · ~${s.changed} changed · ${s.moved} moved · ${s.movedChanged} moved+changed`
}

interface Buckets {
  apiChanged: (SymbolChanged | SymbolMovedChanged)[]
  logicOnly: (SymbolChanged | SymbolMovedChanged)[]
  added: IRSymbol[]
  removed: IRSymbol[]
  movedChanged: SymbolMovedChanged[]
  moved: SymbolMoved[]
  droppedToggled: SymbolDroppedToggled[]
  syntaxOnly: (SymbolChanged | SymbolMovedChanged)[]
}

/**
 * Section routing. §6.2 lists five buckets whose predicates overlap on the raw
 * `SymbolChange[]`: a `changed` entry with both `apiChanged` and `syntaxChanged` belongs
 * in the API section only (higher priority wins). The ordering below is:
 *
 *   1. `apiChanged`         → API 変更
 *   2. `logicChanged` only  → Logic 変更  (api MUST be false to reach here)
 *   3. `syntaxChanged` only → Syntax-only (both api and logic MUST be false)
 *
 * Non-overlapping buckets (added / removed / moved-only / moved+changed / droppedToggled)
 * are routed by the `status` tag alone.
 */
function partition(changes: readonly SymbolChange[]): Buckets {
  const out: Buckets = {
    apiChanged: [],
    logicOnly: [],
    added: [],
    removed: [],
    movedChanged: [],
    moved: [],
    droppedToggled: [],
    syntaxOnly: [],
  }
  for (const c of changes) {
    switch (c.status) {
      case "added":
        out.added.push(c.symbol)
        break
      case "removed":
        out.removed.push(c.symbol)
        break
      case "moved":
        out.moved.push(c)
        break
      case "moved+changed":
        out.movedChanged.push(c)
        routeChanged(c, c.delta, out)
        break
      case "changed":
        routeChanged(c, c.delta, out)
        break
      case "dropped-toggled":
        out.droppedToggled.push(c)
        break
    }
  }
  return out
}

function routeChanged(
  change: SymbolChanged | SymbolMovedChanged,
  delta: SymbolDelta,
  out: Buckets,
): void {
  if (delta.apiChanged) out.apiChanged.push(change)
  else if (delta.logicChanged) out.logicOnly.push(change)
  else if (delta.syntaxChanged) out.syntaxOnly.push(change)
}

function appendSection(lines: string[], heading: string, body: string[]): void {
  if (body.length === 0) return
  lines.push(heading)
  lines.push("")
  lines.push(...body)
  lines.push("")
}

/**
 * §6.1 — bottom-three sections (Moved / Dropped / Syntax-only) live inside a `<details>`
 * fold-out. Skipping the wrapper when body is empty keeps the file from carrying dangling
 * empty `<details>` blocks that GitHub still renders as a clickable arrow.
 */
function appendFolded(lines: string[], heading: string, body: string[]): void {
  if (body.length === 0) return
  lines.push(heading)
  lines.push("")
  lines.push("<details>")
  lines.push(`<summary>${body.length} 件</summary>`)
  lines.push("")
  lines.push(...body)
  lines.push("")
  lines.push("</details>")
  lines.push("")
}

function renderChangedList(items: readonly (SymbolChanged | SymbolMovedChanged)[]): string[] {
  if (items.length === 0) return []
  const rows: string[] = []
  for (const item of sortByAfterId(items)) {
    const sym = item.after
    rows.push(`### \`${sym.name}\` *(${sym.kind})*`)
    rows.push(`**File**: \`${sym.source.file}:${sym.source.startLine}\``)
    rows.push("")
    rows.push(...renderDeltaBody(item.delta))
    rows.push("")
  }
  return rows
}

function renderDeltaBody(delta: SymbolDelta): string[] {
  const rows: string[] = []
  const sig = delta.signature
  if (sig !== null && sig !== undefined) {
    if (sig.outputs.added.length > 0 || sig.outputs.removed.length > 0) {
      const before = sig.outputs.removed.map(String).join(" | ") || "—"
      const after = sig.outputs.added.map(String).join(" | ") || "—"
      rows.push(`- signature.outputs: \`${before}\` → \`${after}\``)
    }
    if (sig.throws.added.length > 0) {
      rows.push(
        `- signature.throws added: ${sig.throws.added.map((t) => `\`${String(t)}\``).join(", ")}`,
      )
    }
    if (sig.throws.removed.length > 0) {
      rows.push(
        `- signature.throws removed: ${sig.throws.removed.map((t) => `\`${String(t)}\``).join(", ")}`,
      )
    }
    if (sig.inputs.added.length > 0) {
      rows.push(`- signature.inputs added: ${sig.inputs.added.length} item(s)`)
    }
    if (sig.inputs.removed.length > 0) {
      rows.push(`- signature.inputs removed: ${sig.inputs.removed.length} item(s)`)
    }
    if (sig.asyncChanged) rows.push(`- signature.async: toggled`)
    if (sig.generatorChanged) rows.push(`- signature.generator: toggled`)
    if (sig.typeParametersChanged) rows.push(`- signature.typeParameters: changed`)
  }
  const decorators = delta.decorators
  if (decorators !== undefined) {
    for (const added of decorators.added) {
      const d = added as { name?: string; raw?: string }
      rows.push(`- decorator added: \`@${d.raw ?? d.name ?? "?"}\``)
    }
    for (const removed of decorators.removed) {
      const d = removed as { name?: string; raw?: string }
      rows.push(`- decorator removed: \`@${d.raw ?? d.name ?? "?"}\``)
    }
    for (const modified of decorators.modified) {
      const d = modified as { name?: string }
      rows.push(`- decorator modified: \`@${d.name ?? "?"}\``)
    }
  }
  const rules = delta.rules
  if (rules !== undefined) {
    appendArrayGroup(rows, "rules", rules.added, rules.removed)
  }
  const effects = delta.effects
  if (effects !== undefined) {
    appendArrayGroup(rows, "effects", effects.added, effects.removed)
  }
  const calls = delta.calls
  if (calls !== undefined) {
    appendArrayGroup(rows, "calls", calls.added, calls.removed)
  }
  if (delta.componentChanged) rows.push(`- component: changed`)
  if (delta.visibilityChanged) rows.push(`- visibility: changed`)
  return rows
}

function appendArrayGroup(
  rows: string[],
  label: string,
  added: readonly unknown[],
  removed: readonly unknown[],
): void {
  if (added.length > 0) {
    rows.push(`- ${label} added:`)
    for (const item of added) rows.push(`  - ${describe(item)}`)
  }
  if (removed.length > 0) {
    rows.push(`- ${label} removed:`)
    for (const item of removed) rows.push(`  - ${describe(item)}`)
  }
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value !== "object") return String(value)
  const obj = value as {
    id?: unknown
    target?: unknown
    line?: unknown
    type?: unknown
    condition?: unknown
    what?: unknown
    expr?: unknown
    name?: unknown
    raw?: unknown
  }
  const line = typeof obj.line === "number" ? ` (L${obj.line})` : ""
  if (typeof obj.id === "string" && typeof obj.target === "string") {
    return `${obj.id}: \`${obj.target}\`${line}`
  }
  if (typeof obj.target === "string") return `\`${obj.target}\`${line}`
  if (typeof obj.type === "string") {
    const detail =
      typeof obj.condition === "string"
        ? `: \`${obj.condition}\``
        : typeof obj.what === "string"
          ? `: \`${obj.what}\``
          : typeof obj.expr === "string"
            ? `: \`${obj.expr}\``
            : ""
    return `${obj.type}${detail}${line}`
  }
  if (typeof obj.raw === "string") return `\`@${obj.raw}\`${line}`
  if (typeof obj.name === "string") return `\`${obj.name}\`${line}`
  return "…"
}

function renderAddedRemoved(symbols: readonly IRSymbol[]): string[] {
  if (symbols.length === 0) return []
  const rows: string[] = []
  for (const s of [...symbols].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    rows.push(`### \`${s.name}\` *(${s.kind})*`)
    rows.push(`**File**: \`${s.source.file}:${s.source.startLine}\``)
    rows.push(...renderSymbolBlock(s).slice(1))
    rows.push("")
  }
  return rows
}

function renderMovedChanged(items: readonly SymbolMovedChanged[]): string[] {
  if (items.length === 0) return []
  const rows: string[] = []
  for (const item of sortByAfterId(items)) {
    rows.push(`### \`${item.after.name}\` *(${item.after.kind})*`)
    rows.push(
      `**Moved**: \`${item.before.source.file}\` → \`${item.after.source.file}\` (\`${item.rationale}\`)`,
    )
    rows.push("**Delta**:")
    rows.push(...renderDeltaBody(item.delta))
    rows.push("")
  }
  return rows
}

function renderMoved(items: readonly SymbolMoved[]): string[] {
  if (items.length === 0) return []
  return [...items]
    .sort((a, b) => (a.after.id < b.after.id ? -1 : 1))
    .map(
      (m) =>
        `- \`${m.after.name}\`: \`${m.before.source.file}\` → \`${m.after.source.file}\` (\`${m.rationale}\`)`,
    )
}

function renderDroppedToggled(items: readonly SymbolDroppedToggled[]): string[] {
  if (items.length === 0) return []
  const toDropped = items.filter((i) => i.direction === "to-dropped")
  const toKept = items.filter((i) => i.direction === "to-kept")
  const rows: string[] = []
  if (toDropped.length > 0) {
    rows.push(`**${toDropped.length} to-dropped**`)
    for (const i of toDropped.sort((a, b) => (a.after.id < b.after.id ? -1 : 1))) {
      rows.push(`- \`${i.after.id}\` — ${i.after.dropReason ?? "unspecified"}`)
    }
  }
  if (toKept.length > 0) {
    if (rows.length > 0) rows.push("")
    rows.push(`**${toKept.length} to-kept**`)
    for (const i of toKept.sort((a, b) => (a.after.id < b.after.id ? -1 : 1))) {
      rows.push(`- \`${i.after.id}\``)
    }
  }
  return rows
}

function renderSyntaxOnly(items: readonly (SymbolChanged | SymbolMovedChanged)[]): string[] {
  if (items.length === 0) return []
  return sortByAfterId(items).map(
    (i) => `- \`${i.after.name}\` (\`${i.after.source.file}:${i.after.source.startLine}\`)`,
  )
}

function renderComponentChanges(diff: DiffResult): string[] {
  const rows: string[] = []
  if (diff.components.added.length > 0) {
    rows.push("### Added")
    for (const c of [...diff.components.added].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      rows.push(`- \`${c.id}\` — roots: ${c.roots.map((r) => `\`${r}\``).join(", ")}`)
    }
    rows.push("")
  }
  if (diff.components.removed.length > 0) {
    rows.push("### Removed")
    for (const c of [...diff.components.removed].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      rows.push(`- \`${c.id}\``)
    }
    rows.push("")
  }
  if (diff.components.changed.length > 0) {
    rows.push("### Changed")
    for (const ch of diff.components.changed) {
      const flags: string[] = []
      if (ch.delta.rootsChanged) flags.push("roots")
      if (ch.delta.publicApiChanged) flags.push("publicApi")
      if (ch.delta.frameworksChanged) flags.push("frameworks")
      rows.push(`- \`${ch.after.id}\`: ${flags.join(", ")}`)
    }
    rows.push("")
  }
  return rows
}

function renderDependencyChanges(diff: DiffResult): string[] {
  const rows: string[] = []
  if (diff.dependencies.added.length > 0) {
    rows.push("### Added")
    for (const d of diff.dependencies.added) {
      rows.push(`- \`${d.from}\` → \`${d.to}\` (via \`${d.via}\`)`)
    }
    rows.push("")
  }
  if (diff.dependencies.removed.length > 0) {
    rows.push("### Removed")
    for (const d of diff.dependencies.removed) {
      rows.push(`- \`${d.from}\` → \`${d.to}\` (via \`${d.via}\`)`)
    }
    rows.push("")
  }
  return rows
}

function sortByAfterId<T extends { after: IRSymbol }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.after.id < b.after.id ? -1 : a.after.id > b.after.id ? 1 : 0))
}
