import type {
  Dependency,
  DiffResult,
  Symbol as IRSymbol,
  SliceRecord,
  SymbolChange,
  SymbolChanged,
  SymbolDelta,
  SymbolDroppedToggled,
  SymbolMoved,
  SymbolMovedChanged,
} from "@aburi/types"
import { renderSymbolBlock } from "./component"
import { compareStrings, isSymbolIdEndpoint, requireDropReason } from "./format"

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
  appendSection(lines, "## 🧵 Slice View", renderSliceView(diff.slices, diff.symbols))
  appendSection(lines, "## ➕ Added", renderAddedRemoved(buckets.added))
  appendSection(lines, "## ➖ Removed", renderAddedRemoved(buckets.removed))
  appendSection(lines, "## 🔀 Moved + Changed", renderMovedChanged(buckets.movedChanged))
  appendFolded(lines, "## 🔀 Moved", renderMoved(buckets.moved))
  appendSection(lines, "## 🧱 Component changes", renderComponentChanges(diff))
  appendSection(lines, "## 🔗 Dependency changes", renderDependencyChanges(diff))
  appendFolded(lines, "## 💧 Dropped changes", renderDroppedToggled(buckets.droppedToggled))
  appendFolded(lines, "## 🎨 Syntax-only changes", renderSyntaxOnly(buckets.syntaxOnly))

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`
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

/**
 * §12 — the Slice View section. Renders every non-singleton Slice as a `###`
 * subsection followed by member bullets, then collapses singleton Slices into
 * one `<details>` "Standalone changes" block. If the whole list is empty the
 * whole section is skipped (empty body → `appendSection` no-op → §12.5 omit).
 *
 * The `symbols[]` array from the diff is used to look up each member's
 * SymbolChange record for per-bullet detail (status label, file:line, delta /
 * effect summary). Members that do not appear in `symbols[]` are still
 * rendered with just the id so a rendering-side mistake never silently
 * elides a member the pass emitted.
 */
function renderSliceView(
  slices: readonly SliceRecord[],
  symbols: readonly SymbolChange[],
): string[] {
  if (slices.length === 0) return []

  const changeById = indexChangesById(symbols)
  const nonSingleton = slices.filter((s) => s.members.length >= 2)
  const singleton = slices.filter((s) => s.members.length === 1)

  const rows: string[] = []
  rows.push(...renderUnresolvedCallNote(slices, changeById))
  for (let i = 0; i < nonSingleton.length; i++) {
    const slice = nonSingleton[i] as SliceRecord
    rows.push(...renderSliceSection(slice, changeById))
    rows.push("---")
    rows.push("")
  }

  if (singleton.length > 0) {
    rows.push("### Standalone changes")
    rows.push("")
    rows.push("<details>")
    rows.push(
      `<summary>${singleton.length} singleton slices (no in-Node call-graph neighbours)</summary>`,
    )
    rows.push("")
    for (const slice of singleton) {
      const memberId = slice.members[0] as string
      const label = renderSingletonLabel(memberId, slice.id, changeById)
      rows.push(`- \`${slice.id}\` — ${label}`)
    }
    rows.push("")
    rows.push("</details>")
  }
  return rows
}

/**
 * §12.2 — render one non-singleton Slice. The heading uses the full sliceId
 * (surrounded by backticks so Markdown viewers do not try to auto-link the
 * `:` / `/` / `#` inside it) and the member count. Each member becomes a
 * three-line bullet cluster: short qname + status italic, `**File**` line,
 * and a `↳` follow-up summarising which delta axes tripped (or, for added /
 * removed, a short "new symbol" / "removed symbol" marker).
 */
function renderSliceSection(
  slice: SliceRecord,
  changeById: ReadonlyMap<string, SymbolChange>,
): string[] {
  const rows: string[] = []
  rows.push(`### \`${slice.id}\` (${slice.members.length} members)`)
  rows.push("")
  for (const memberId of slice.members) {
    const change = requireChangeForMember(memberId, slice.id, changeById)
    const symbol = symbolForMember(change)
    rows.push(`- \`${symbol.name}\` — *(${change.status})*`)
    rows.push(`  **File**: \`${symbol.source.file}:${symbol.source.startLine}\``)
    rows.push(`  ↳ ${renderMemberFollowup(change)}${unresolvedCallMarker(symbol)}`)
  }
  rows.push("")
  return rows
}

/**
 * §12.6 — the note that turns `slice-view.md` §5.4's silent drop into something
 * a reviewer can act on. An unresolved call emits no `CallEdge`, so a Slice that
 * "should" have bridged Controller → Service may show up as two singletons
 * instead. The counts come straight from the members' own `calls[].resolved`,
 * which the diff already embeds — no new schema field, no new pass.
 *
 * Only the members' own calls are counted, and that is sufficient: §5.1 draws an
 * edge only when both endpoints are Nodes, so any edge that would have merged
 * two Slices originates at one of the members shown here.
 */
function renderUnresolvedCallNote(
  slices: readonly SliceRecord[],
  changeById: ReadonlyMap<string, SymbolChange>,
): string[] {
  let affectedMembers = 0
  let unresolvedCalls = 0
  for (const slice of slices) {
    for (const memberId of slice.members) {
      const change = changeById.get(memberId)
      if (change === undefined) continue
      const count = countUnresolvedCalls(symbolForMember(change))
      if (count === 0) continue
      affectedMembers++
      unresolvedCalls += count
    }
  }
  if (unresolvedCalls === 0) return []
  const verb = affectedMembers === 1 ? "makes" : "make"
  const calls = unresolvedCalls === 1 ? "1 call" : `${unresolvedCalls} calls`
  return [
    `> ⚠ ${affectedMembers} of the changed symbols below ${verb} ${calls} the resolver could not identify, so a Slice here may be split rather than genuinely disconnected (call-resolution.md §8.1).`,
    "",
  ]
}

function countUnresolvedCalls(symbol: IRSymbol): number {
  let count = 0
  for (const call of symbol.calls) if (call.resolved === null) count++
  return count
}

/** Trailing marker for one member. Empty when the member resolved cleanly. */
function unresolvedCallMarker(symbol: IRSymbol): string {
  const count = countUnresolvedCalls(symbol)
  if (count === 0) return ""
  return ` · ⚠ ${pluralizeCalls(count)}`
}

function pluralizeCalls(count: number): string {
  return count === 1 ? "1 unresolved call" : `${count} unresolved calls`
}

function renderSingletonLabel(
  memberId: string,
  sliceId: string,
  changeById: ReadonlyMap<string, SymbolChange>,
): string {
  const change = requireChangeForMember(memberId, sliceId, changeById)
  const symbol = symbolForMember(change)
  return `\`${symbol.name}\` *(${change.status})*${unresolvedCallMarker(symbol)}`
}

/**
 * Every Slice member is defined as a Node in slice-view.md §4.1, and every
 * Node is emitted by `buildDiff` as a SymbolChange in `diff.symbols[]`. A
 * missing entry therefore means the producer violated the pass invariant
 * ("union of all members equals the Node set", §11.2) — we throw so the
 * mismatch surfaces at render time instead of being silently masked with
 * an "unknown" label the reviewer cannot interpret.
 */
function requireChangeForMember(
  memberId: string,
  sliceId: string,
  changeById: ReadonlyMap<string, SymbolChange>,
): SymbolChange {
  const change = changeById.get(memberId)
  if (change === undefined) {
    throw new Error(
      `projectDiff: slice ${sliceId} lists member ${memberId} that is not present in diff.symbols[]; ` +
        `every Slice member must have a corresponding SymbolChange (slice-view.md §11.2).`,
    )
  }
  return change
}

/**
 * Pick the SymbolChange's IRSymbol side that best represents the member's
 * head-visible identity (§4.1): `after` for changed / moved+changed /
 * dropped-toggled, `symbol` for added / removed. Pure `moved` never reaches
 * this function because pure moved Symbols are excluded from the Node set
 * (§4.3), but the switch stays exhaustive to keep TypeScript's type
 * narrowing engaged.
 */
function symbolForMember(change: SymbolChange): IRSymbol {
  switch (change.status) {
    case "added":
    case "removed":
      return change.symbol
    case "changed":
    case "moved+changed":
    case "dropped-toggled":
      return change.after
    case "moved":
      return change.after
  }
}

function renderMemberFollowup(change: SymbolChange): string {
  switch (change.status) {
    case "added":
      return "new symbol"
    case "removed":
      return "removed symbol"
    case "moved":
      return `moved: \`${change.before.source.file}\` → \`${change.after.source.file}\``
    case "changed":
    case "moved+changed":
      return deltaAxisSummary(change.delta)
    case "dropped-toggled":
      return `dropped-toggled: ${change.direction}`
  }
}

function deltaAxisSummary(delta: SymbolDelta): string {
  const axes: string[] = []
  if (delta.apiChanged) axes.push("delta.apiChanged")
  if (delta.logicChanged) axes.push("delta.logicChanged")
  if (delta.syntaxChanged) axes.push("delta.syntaxChanged")
  if (delta.componentChanged) axes.push("delta.componentChanged")
  if (delta.visibilityChanged) axes.push("delta.visibilityChanged")
  return axes.length === 0 ? "no delta axes" : axes.join(", ")
}

function indexChangesById(symbols: readonly SymbolChange[]): Map<string, SymbolChange> {
  const map = new Map<string, SymbolChange>()
  for (const change of symbols) {
    switch (change.status) {
      case "added":
      case "removed":
        map.set(change.symbol.id, change)
        break
      case "changed":
      case "moved+changed":
      case "dropped-toggled":
        map.set(change.after.id, change)
        break
      case "moved":
        map.set(change.after.id, change)
        break
    }
  }
  return map
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

/**
 * §6 Dependency changes — split into two levels so reviewers can scan
 * component-shape movement (architectural) separately from method call
 * movement (implementation detail). Both live in the same section heading
 * because both are `Dependency` records under the hood; the sub-headings
 * (`### Component-level added`, `### Symbol-level added`, ...) do the routing.
 * A group that has no entries collapses entirely — an empty section reads as
 * "nothing changed at this level", not as an intentional silence.
 */
function renderDependencyChanges(diff: DiffResult): string[] {
  const compAdded = diff.dependencies.added.filter((d) => !isSymbolEdge(d))
  const compRemoved = diff.dependencies.removed.filter((d) => !isSymbolEdge(d))
  const symAdded = diff.dependencies.added.filter((d) => isSymbolEdge(d))
  const symRemoved = diff.dependencies.removed.filter((d) => isSymbolEdge(d))

  const rows: string[] = []
  appendDependencyGroup(rows, "Component-level added", compAdded)
  appendDependencyGroup(rows, "Component-level removed", compRemoved)
  appendDependencyGroup(rows, "Symbol-level added", symAdded)
  appendDependencyGroup(rows, "Symbol-level removed", symRemoved)
  return rows
}

function appendDependencyGroup(rows: string[], heading: string, deps: readonly Dependency[]): void {
  if (deps.length === 0) return
  rows.push(`### ${heading}`)
  for (const d of deps) {
    rows.push(`- \`${d.from}\` → \`${d.to}\` (via \`${d.via}\`)`)
  }
  rows.push("")
}

function isSymbolEdge(d: Dependency): boolean {
  return isSymbolIdEndpoint(d.from) || isSymbolIdEndpoint(d.to)
}

function sortByAfterId<T extends { after: IRSymbol }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.after.id < b.after.id ? -1 : a.after.id > b.after.id ? 1 : 0))
}
