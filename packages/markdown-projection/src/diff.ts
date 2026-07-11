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
import { compareStrings, requireDropReason } from "./format"

/**
 * §6 — `out/diff.md`. Sections are emitted in the fixed importance order
 * (API changes → Syntax-only). Three sections — Moved (semantic no-op), Dropped changes
 * (drop rule flips), Syntax-only changes (implementation refactors) — are collapsed inside
 * `<details>` so PR comments stay reviewer-friendly. Moved + Changed is intentionally
 * NOT folded because the delta carries semantic impact worth reading. Empty sections
 * are dropped entirely (§5.3 rule).
 */
export function projectDiff(diff: DiffResult): string {
  const lines: string[] = []
  lines.push(`# Aburi diff: ${diff.base.ref}..${diff.head.ref}`)
  lines.push("")
  lines.push(`**Summary**: ${summaryLine(diff)}`)
  lines.push("")

  const buckets = partition(diff.symbols)

  appendSection(lines, "## ⚠ API changes", renderChangedList(buckets.apiChanged))
  appendSection(lines, "## 🔧 Logic changes", renderChangedList(buckets.logicOnly))
  appendSection(lines, "## ➕ Added", renderAddedRemoved(buckets.added))
  appendSection(lines, "## ➖ Removed", renderAddedRemoved(buckets.removed))
  appendSection(lines, "## 🔀 Moved + Changed", renderMovedChanged(buckets.movedChanged))
  appendFolded(lines, "## 🔀 Moved", renderMoved(buckets.moved))
  appendSection(lines, "## 🧱 Component changes", renderComponentChanges(diff))
  appendSection(lines, "## 🔗 Dependency changes", renderDependencyChanges(diff))
  appendFolded(lines, "## 💧 Dropped changes", renderDroppedToggled(buckets.droppedToggled))
  appendFolded(lines, "## 🎨 Syntax-only changes", renderSyntaxOnly(buckets.syntaxOnly))

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
 *   1. `apiChanged`         → API changes
 *   2. `logicChanged` only  → Logic changes  (api MUST be false to reach here)
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
 * §6.1 — three sections (Moved / Dropped / Syntax-only) live inside a `<details>`
 * fold-out. Skipping the wrapper when body is empty keeps the file from carrying dangling
 * empty `<details>` blocks that GitHub still renders as a clickable arrow.
 */
function appendFolded(lines: string[], heading: string, body: string[]): void {
  if (body.length === 0) return
  lines.push(heading)
  lines.push("")
  lines.push("<details>")
  lines.push(`<summary>${body.length} entries</summary>`)
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
  appendSignatureDelta(rows, delta.signature ?? null)
  appendDecoratorDelta(rows, delta.decorators)
  appendRuleDelta(rows, delta.rules)
  appendEffectDelta(rows, delta.effects)
  appendCallDelta(rows, delta.calls)
  if (delta.componentChanged) rows.push(`- component: changed`)
  if (delta.visibilityChanged) rows.push(`- visibility: changed`)
  return rows
}

function appendSignatureDelta(
  rows: string[],
  sig: NonNullable<SymbolDelta["signature"]> | null,
): void {
  if (sig === null) return
  if (sig.outputs.added.length > 0 || sig.outputs.removed.length > 0) {
    const before = renderStringList(sig.outputs.removed)
    const after = renderStringList(sig.outputs.added)
    rows.push(`- signature.outputs: \`${before}\` → \`${after}\``)
  }
  if (sig.throws.added.length > 0) {
    rows.push(`- signature.throws added: ${renderInlineList(sig.throws.added)}`)
  }
  if (sig.throws.removed.length > 0) {
    rows.push(`- signature.throws removed: ${renderInlineList(sig.throws.removed)}`)
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

/**
 * `ArrayDelta.added/removed/modified` is typed `unknown[]` in the generated schema layer
 * because the schema erases the per-field element type. The runtime shape, however, is
 * fixed: `delta.decorators` items are always Decorators, `delta.rules` items are Rules,
 * etc. Rather than sprinkling `as` casts, we route through predicate-narrowed helpers
 * so a schema regeneration that adds a field will fail to compile here instead of
 * silently emitting `@?` placeholders.
 */
function appendDecoratorDelta(rows: string[], delta: SymbolDelta["decorators"]): void {
  if (delta === undefined) return
  for (const raw of delta.added) {
    const d = asDecoratorLike(raw)
    if (d === null) continue
    rows.push(`- decorator added: \`@${d.raw ?? d.name}\``)
  }
  for (const raw of delta.removed) {
    const d = asDecoratorLike(raw)
    if (d === null) continue
    rows.push(`- decorator removed: \`@${d.raw ?? d.name}\``)
  }
  for (const raw of delta.modified) {
    const d = asDecoratorLike(raw)
    if (d === null) continue
    rows.push(`- decorator modified: \`@${d.name}\``)
  }
}

function appendRuleDelta(rows: string[], delta: SymbolDelta["rules"]): void {
  if (delta === undefined) return
  appendArrayGroup(rows, "rules", delta.added, delta.removed, describeRuleLike)
}

function appendEffectDelta(rows: string[], delta: SymbolDelta["effects"]): void {
  if (delta === undefined) return
  appendArrayGroup(rows, "effects", delta.added, delta.removed, describeEffectLike)
}

function appendCallDelta(rows: string[], delta: SymbolDelta["calls"]): void {
  if (delta === undefined) return
  appendArrayGroup(rows, "calls", delta.added, delta.removed, describeCallLike)
}

function appendArrayGroup(
  rows: string[],
  label: string,
  added: readonly unknown[],
  removed: readonly unknown[],
  describe: (item: unknown) => string | null,
): void {
  if (added.length > 0) {
    const lines = added.map(describe).filter((line): line is string => line !== null)
    if (lines.length > 0) {
      rows.push(`- ${label} added:`)
      for (const line of lines) rows.push(`  - ${line}`)
    }
  }
  if (removed.length > 0) {
    const lines = removed.map(describe).filter((line): line is string => line !== null)
    if (lines.length > 0) {
      rows.push(`- ${label} removed:`)
      for (const line of lines) rows.push(`  - ${line}`)
    }
  }
}

// -----------------------------------------------------------------------------
// Predicate-narrowed views of ArrayDelta entries
// -----------------------------------------------------------------------------

interface DecoratorLike {
  name: string
  raw?: string | undefined
}
interface RuleLike {
  type: string
  line: number
  condition?: string | undefined
  what?: string | undefined
  expr?: string | undefined
}
interface EffectLike {
  id: string
  target: string
  line: number
}
interface CallLike {
  target: string
  line: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asDecoratorLike(value: unknown): DecoratorLike | null {
  if (!isRecord(value)) return null
  const name = value.name
  const raw = value.raw
  if (typeof name !== "string") return null
  return { name, raw: typeof raw === "string" ? raw : undefined }
}

function asRuleLike(value: unknown): RuleLike | null {
  if (!isRecord(value)) return null
  const type = value.type
  const line = value.line
  if (typeof type !== "string" || typeof line !== "number") return null
  const readOptional = (key: "condition" | "what" | "expr"): string | undefined => {
    const v = value[key]
    return typeof v === "string" ? v : undefined
  }
  return {
    type,
    line,
    condition: readOptional("condition"),
    what: readOptional("what"),
    expr: readOptional("expr"),
  }
}

function asEffectLike(value: unknown): EffectLike | null {
  if (!isRecord(value)) return null
  const { id, target, line } = value
  if (typeof id !== "string" || typeof target !== "string" || typeof line !== "number") return null
  return { id, target, line }
}

function asCallLike(value: unknown): CallLike | null {
  if (!isRecord(value)) return null
  const { target, line } = value
  if (typeof target !== "string" || typeof line !== "number") return null
  return { target, line }
}

function describeRuleLike(value: unknown): string | null {
  const rule = asRuleLike(value)
  if (rule === null) return null
  const detail = rule.condition ?? rule.what ?? rule.expr
  const detailPart = detail === undefined ? "" : `: \`${detail}\``
  return `${rule.type}${detailPart} (L${rule.line})`
}

function describeEffectLike(value: unknown): string | null {
  const eff = asEffectLike(value)
  if (eff === null) return null
  return `${eff.id}: \`${eff.target}\` (L${eff.line})`
}

function describeCallLike(value: unknown): string | null {
  const c = asCallLike(value)
  if (c === null) return null
  return `\`${c.target}\` (L${c.line})`
}

function renderStringList(values: readonly unknown[]): string {
  const strings = values.filter((v): v is string => typeof v === "string")
  return strings.length === 0 ? "—" : strings.join(" | ")
}

function renderInlineList(values: readonly unknown[]): string {
  return values
    .filter((v): v is string => typeof v === "string")
    .map((s) => `\`${s}\``)
    .join(", ")
}

function renderAddedRemoved(symbols: readonly IRSymbol[]): string[] {
  if (symbols.length === 0) return []
  const rows: string[] = []
  for (const s of [...symbols].sort((a, b) => compareStrings(a.id, b.id))) {
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
    .sort((a, b) => compareStrings(a.after.id, b.after.id))
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
    for (const i of toDropped.sort((a, b) => compareStrings(a.after.id, b.after.id))) {
      rows.push(`- \`${i.after.id}\` — ${requireDropReason(i.after)}`)
    }
  }
  if (toKept.length > 0) {
    if (rows.length > 0) rows.push("")
    rows.push(`**${toKept.length} to-kept**`)
    for (const i of toKept.sort((a, b) => compareStrings(a.after.id, b.after.id))) {
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
    for (const c of [...diff.components.added].sort((a, b) => compareStrings(a.id, b.id))) {
      rows.push(`- \`${c.id}\` — roots: ${c.roots.map((r) => `\`${r}\``).join(", ")}`)
    }
    rows.push("")
  }
  if (diff.components.removed.length > 0) {
    rows.push("### Removed")
    for (const c of [...diff.components.removed].sort((a, b) => compareStrings(a.id, b.id))) {
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
