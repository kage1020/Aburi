import type {
  Component,
  Dependency,
  DependencyUnknown,
  DiffResult,
  Symbol as IRSymbol,
  NotComparedFile,
  SliceId,
  SliceRecord,
  SymbolChange,
  SymbolChanged,
  SymbolDelta,
  SymbolDroppedToggled,
  SymbolId,
  SymbolMoved,
  SymbolMovedChanged,
  SymbolUnknown,
} from "@aburi/types"
import { renderSymbolBlock } from "./component"
import {
  compareStrings,
  inlineCode,
  isSymbolEdge,
  renderDocument,
  requireDropReason,
} from "./format"

/** Options for {@link projectDiff}. */
export interface ProjectDiffOptions {
  /**
   * markdown-projection.md — hard cap on the document in UTF-8 bytes (GitHub rejects a
   * comment over 65536), honoured by dropping whole sections least important first, never by
   * cutting the string. Must be a positive integer (`0` throws `RangeError`); absent means no
   * cap.
   */
  readonly maxBytes?: number
}

/**
 * markdown-projection.md — `out/diff.md`. Sections are emitted in the fixed importance order
 * (API changes → Syntax-only). Moved, Dropped changes and Syntax-only changes are folded
 * inside `<details>`; Moved + Changed is not, because its delta carries semantic impact.
 * Empty sections are dropped.
 */
export function projectDiff(diff: DiffResult, options: ProjectDiffOptions = {}): string {
  const heading: string[] = []
  heading.push(`# Aburi diff: ${diff.base.ref}..${diff.head.ref}`)
  heading.push("")
  heading.push(`**Summary**: ${summaryLine(diff)}`)
  heading.push("")

  const buckets = partition(diff.symbols)
  const sections: Section[] = []

  appendSection(sections, "## ⚠ API changes", renderChangedList(buckets.apiChanged))
  appendSection(sections, "## 🔧 Logic changes", renderChangedList(buckets.logicOnly))
  appendSection(sections, "## 🧵 Slice View", renderSliceView(diff.slices, diff.symbols))
  appendSection(sections, "## ➕ Added", renderAddedRemoved(buckets.added))
  appendSection(sections, "## ➖ Removed", renderAddedRemoved(buckets.removed))
  appendSection(sections, "## ❔ Unknown", renderUnknown(buckets.unknown))
  // `?? []` renders nothing for a diff that predates the field, which is the right answer:
  // such a document cannot say what it missed, and a section built from an assumed empty list
  // would report "nothing was missed" on every archived diff.
  appendSection(sections, "## 🚫 Not compared", renderNotCompared(diff.notCompared ?? []))
  appendSection(sections, "## 🔀 Moved + Changed", renderMovedChanged(buckets.movedChanged))
  appendFolded(sections, "## 🔀 Moved", renderMoved(buckets.moved), buckets.moved.length)
  appendSection(sections, "## 🧱 Component changes", renderComponentChanges(diff))
  appendSection(sections, "## 🔗 Dependency changes", renderDependencyChanges(diff))
  appendFolded(
    sections,
    "## 💧 Dropped changes",
    renderDroppedToggled(buckets.droppedToggled),
    buckets.droppedToggled.length,
  )
  appendFolded(
    sections,
    "## 🎨 Syntax-only changes",
    renderSyntaxOnly(buckets.syntaxOnly),
    buckets.syntaxOnly.length,
  )

  return assemble(heading, sections, options.maxBytes)
}

/**
 * One rendered `##` block, kept whole so the size cap has something it can drop without
 * leaving half a document behind. `title` is the heading without its `## `, for the note
 * that names what went.
 */
interface Section {
  readonly title: string
  readonly lines: readonly string[]
}

/**
 * Join the document, dropping sections from the bottom until it fits (markdown-projection.md,
 * `maxBytes`). The section order is the importance order — fixed so a reviewer can read from
 * the top, with API changes first and Syntax-only folded at the bottom — so the bottom is the
 * least important thing in the document and the drop order falls straight out of it:
 * Syntax-only first, API changes last. The note is rebuilt and the document re-measured on
 * every drop, because naming one more section lengthens the note. The title and Summary line
 * cannot be dropped, so the last document may still be over budget; only that one takes the
 * "could not be brought within" wording.
 */
function assemble(
  heading: readonly string[],
  sections: readonly Section[],
  maxBytes: number | undefined,
): string {
  if (maxBytes === undefined) return renderDocument([...heading, ...flatten(sections)])
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError(
      `projectDiff: maxBytes must be a positive integer (got ${String(maxBytes)}).`,
    )
  }

  const render = (kept: number, unachievable: boolean): string =>
    renderDocument([
      ...heading,
      ...omissionNote(sections.slice(kept), maxBytes, unachievable),
      ...flatten(sections.slice(0, kept)),
    ])

  for (let kept = sections.length; ; kept--) {
    const document = render(kept, false)
    if (Buffer.byteLength(document, "utf8") <= maxBytes) return document
    if (kept === 0) return render(0, true)
  }
}

/**
 * The line that stands in for what was dropped, naming sections in document order (the
 * reader is looking for the heading that is not there). `unachievable` is the path where
 * every section went and the document is still over budget.
 */
function omissionNote(
  dropped: readonly Section[],
  maxBytes: number,
  unachievable: boolean,
): string[] {
  if (dropped.length === 0) return []
  const subject = dropped.length === 1 ? "1 section was" : `${dropped.length} sections were`
  const names = dropped.map((section) => section.title).join(", ")
  const budget = unachievable
    ? `and this report still could not be brought within ${maxBytes} bytes`
    : `to keep this report within ${maxBytes} bytes`
  return [
    `> ⚠ **${subject} omitted** ${budget}: ${names}. ` +
      `The full report is the same diff rendered without a size cap.`,
    "",
  ]
}

function flatten(sections: readonly Section[]): string[] {
  return sections.flatMap((section) => [...section.lines])
}

/** markdown-projection.md — one-line CLI stdout summary. */
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

/**
 * Append the unknown count to a summary line when there is one: the added and removed counts
 * beside it are smaller than the truth by exactly this much. Appended rather than always
 * present, so the line does not grow a permanent `?0` on diffs where nothing was lost.
 */
function withUnknown(line: string, diff: DiffResult): string {
  const unknown = diff.summary.unknown ?? 0
  return unknown === 0 ? line : `${line} · ?${unknown} unknown`
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
  unknown: SymbolUnknown[]
}

/**
 * Section routing (markdown-projection.md). The delta flags overlap, so `routeChanged`
 * applies a priority: `apiChanged` → API changes, else `logicChanged` → Logic changes, else
 * `syntaxChanged` → Syntax-only. The other buckets are routed by the `status` tag alone.
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
    unknown: [],
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
      case "unknown":
        out.unknown.push(c)
        break
      default:
        // This switch accumulates rather than returns, so without the guard a status added
        // later would simply vanish from every section of `diff.md`.
        return assertNeverChange(c)
    }
  }
  return out
}

function assertNeverChange(change: never): never {
  throw new Error(`Unhandled SymbolChange status: ${JSON.stringify(change)}`)
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

function appendSection(sections: Section[], heading: string, body: string[]): void {
  if (body.length === 0) return
  sections.push({ title: titleOf(heading), lines: [heading, "", ...body, ""] })
}

/**
 * §6.1 — three sections (Moved / Dropped / Syntax-only) live inside a `<details>`
 * fold-out. Skipping the wrapper when body is empty keeps the file from carrying dangling
 * empty `<details>` blocks that GitHub still renders as a clickable arrow. `entryCount` is
 * passed separately because Dropped prefixes direction groups with headings and separators,
 * so its rendered row count can exceed the number of entries.
 */
function appendFolded(
  sections: Section[],
  heading: string,
  body: string[],
  entryCount: number,
): void {
  if (body.length === 0) return
  sections.push({
    title: titleOf(heading),
    lines: [
      heading,
      "",
      "<details>",
      `<summary>${entryCount} entries</summary>`,
      "",
      ...body,
      "",
      "</details>",
      "",
    ],
  })
}

/** The heading as the reader sees it in the document, minus the `## ` the note has no use for. */
function titleOf(heading: string): string {
  return heading.replace(/^#+ */, "")
}

function renderChangedList(items: readonly (SymbolChanged | SymbolMovedChanged)[]): string[] {
  if (items.length === 0) return []
  const rows: string[] = []
  for (const item of sortByAfterId(items)) {
    const sym = item.after
    rows.push(`### ${inlineCode(sym.name)} *(${sym.kind})*`)
    rows.push(`**File**: ${inlineCode(`${sym.source.file}:${sym.source.startLine}`)}`)
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
  appendUnexplainedChangeNote(delta, rows)
  return rows
}

/**
 * Never leave a heading with an empty body: it would read as "no reason was found". A note
 * rather than a thrown invariant, because the fingerprints cover inputs the structured delta
 * does not model, so a real document can set a flag with every `ArrayDelta` empty. All three
 * flags are covered because `renderMovedChanged` reaches here with syntax-only moves too.
 */
function appendUnexplainedChangeNote(delta: SymbolDelta, rows: string[]): void {
  if (rows.length > 0) return
  const which = delta.apiChanged
    ? "API"
    : delta.logicChanged
      ? "logic"
      : delta.syntaxChanged
        ? "syntax"
        : null
  if (which === null) return
  rows.push(`- ${which} fingerprint changed; no field-level detail was recorded`)
}

function appendSignatureDelta(
  rows: string[],
  sig: NonNullable<SymbolDelta["signature"]> | null,
): void {
  if (sig === null) return
  if (sig.outputs.added.length > 0 || sig.outputs.removed.length > 0) {
    const before = renderStringList(sig.outputs.removed)
    const after = renderStringList(sig.outputs.added)
    rows.push(`- signature.outputs: ${inlineCode(before)} → ${inlineCode(after)}`)
  }
  appendInlineRow(rows, "signature.outputs modified", sig.outputs.modified)
  appendInlineRow(rows, "signature.throws added", sig.throws.added)
  appendInlineRow(rows, "signature.throws removed", sig.throws.removed)
  appendInlineRow(rows, "signature.throws modified", sig.throws.modified)
  if (sig.inputs.added.length > 0) {
    rows.push(`- signature.inputs added: ${describeInputs(sig.inputs.added)}`)
  }
  if (sig.inputs.removed.length > 0) {
    rows.push(`- signature.inputs removed: ${describeInputs(sig.inputs.removed)}`)
  }
  // `inputs` keys on `${index}:${name}`, so a parameter whose type changed while its name
  // and position held lands here and only here — the single most common breaking API
  // change. Rendering a count, as added/removed once did, would say nothing about it.
  if (sig.inputs.modified.length > 0) {
    rows.push(`- signature.inputs modified: ${describeInputs(sig.inputs.modified)}`)
  }
  if (sig.asyncChanged) rows.push(`- signature.async: toggled`)
  if (sig.generatorChanged) rows.push(`- signature.generator: toggled`)
  if (sig.typeParametersChanged) rows.push(`- signature.typeParameters: changed`)
}

/**
 * `ArrayDelta` buckets are `unknown[]` because the schema erases the element type, while the
 * runtime shape is fixed per field. The `as*Like` predicates narrow them without casts, so a
 * schema regeneration fails to compile here instead of emitting `@?` placeholders.
 *
 * One row per decorator rather than `appendArrayGroup`'s nested list; `modified` shows the
 * name alone because the arguments are the change.
 */
function appendDecoratorDelta(rows: string[], delta: SymbolDelta["decorators"]): void {
  if (delta === undefined) return
  const buckets: [string, readonly unknown[], (d: DecoratorLike) => string][] = [
    ["added", delta.added, (d) => d.raw ?? d.name],
    ["removed", delta.removed, (d) => d.raw ?? d.name],
    ["modified", delta.modified, (d) => d.name],
  ]
  for (const [label, items, show] of buckets) {
    for (const item of items) {
      const decorator = asDecoratorLike(item)
      if (decorator === null) continue
      rows.push(`- decorator ${label}: ${inlineCode(`@${show(decorator)}`)}`)
    }
  }
}

function appendRuleDelta(rows: string[], delta: SymbolDelta["rules"]): void {
  if (delta === undefined) return
  appendArrayGroup(rows, "rules", delta, describeRuleLike)
}

function appendEffectDelta(rows: string[], delta: SymbolDelta["effects"]): void {
  if (delta === undefined) return
  appendArrayGroup(rows, "effects", delta, describeEffectLike)
}

function appendCallDelta(rows: string[], delta: SymbolDelta["calls"]): void {
  if (delta === undefined) return
  appendArrayGroup(rows, "calls", delta, describeCallLike)
}

/**
 * All three `ArrayDelta` buckets: `@aburi/diff` routes an element whose identity key matched
 * but whose content changed into `modified`, so a rewritten guard condition or a call that
 * stopped resolving arrives there and nowhere else.
 */
function appendArrayGroup(
  rows: string[],
  label: string,
  delta: NonNullable<SymbolDelta["rules"]>,
  describe: (item: unknown) => string | null,
): void {
  appendBucket(rows, `${label} added`, delta.added, describe)
  appendBucket(rows, `${label} removed`, delta.removed, describe)
  appendBucket(rows, `${label} modified`, delta.modified, describe)
}

function appendBucket(
  rows: string[],
  label: string,
  items: readonly unknown[],
  describe: (item: unknown) => string | null,
): void {
  if (items.length === 0) return
  const lines = items.map(describe).filter((line): line is string => line !== null)
  if (lines.length === 0) return
  rows.push(`- ${label}:`)
  for (const line of lines) rows.push(`  - ${line}`)
}

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

/**
 * The delta's own rule row, nested under `- rules added:` — not `ruleRow`, and inline however
 * long the condition: a delta bucket lists the rules that moved rather than showing each in
 * full, and a widened code span holds any condition on one line.
 */
function describeRuleLike(value: unknown): string | null {
  const rule = asRuleLike(value)
  if (rule === null) return null
  const detail = rule.condition ?? rule.what ?? rule.expr
  const detailPart = detail === undefined ? "" : `: ${inlineCode(detail)}`
  return `${rule.type}${detailPart} (L${rule.line})`
}

function describeEffectLike(value: unknown): string | null {
  const eff = asEffectLike(value)
  if (eff === null) return null
  return `${eff.id}: ${inlineCode(eff.target)} (L${eff.line})`
}

function describeCallLike(value: unknown): string | null {
  const call = asCallLike(value)
  if (call === null) return null
  return `${inlineCode(call.target)} (L${call.line})`
}

/**
 * `Signature.inputs` entries as `name: type`. If every entry fails the shape, the count is
 * emitted instead — unlike `appendBucket` — because "1 item(s)" at least says a parameter
 * moved, where silence would claim none did.
 */
function describeInputs(items: readonly unknown[]): string {
  const rendered = items
    .map((value) => {
      if (!isRecord(value)) return null
      const { name, type } = value
      if (typeof name !== "string" || typeof type !== "string") return null
      return inlineCode(`${name}: ${type}`)
    })
    .filter((line): line is string => line !== null)
  return rendered.length > 0 ? rendered.join(", ") : `${items.length} item(s)`
}

function renderStringList(values: readonly unknown[]): string {
  const strings = values.filter((v): v is string => typeof v === "string")
  return strings.length === 0 ? "—" : strings.join(" | ")
}

function renderInlineList(values: readonly unknown[]): string {
  return values
    .filter((v): v is string => typeof v === "string")
    .map((s) => inlineCode(s))
    .join(", ")
}

/** Emit `- <label>: <values>` only when something renders, mirroring `appendBucket`. */
function appendInlineRow(rows: string[], label: string, values: readonly unknown[]): void {
  if (values.length === 0) return
  const rendered = renderInlineList(values)
  if (rendered === "") return
  rows.push(`- ${label}: ${rendered}`)
}

function renderAddedRemoved(symbols: readonly IRSymbol[]): string[] {
  return [...symbols]
    .sort((a, b) => compareStrings(a.id, b.id))
    .flatMap((symbol) => symbolEntry(symbol, []))
}

/**
 * The Symbols one document has and the other never looked for (markdown-projection.md).
 * Apart from Added and Removed because the reader's next action differs: an entry here is a
 * gap to close, and the reason says how — `parse-timeout` and `unreadable` usually clear on
 * a re-run, while
 * `parse-failed`, `extraction-failed`, `over-size` and `unroutable` describe the file or the
 * plugin set.
 */
function renderUnknown(items: readonly SymbolUnknown[]): string[] {
  return [...items]
    .sort((a, b) => compareStrings(a.symbol.id, b.symbol.id))
    .flatMap((item) => symbolEntry(item.symbol, [`**Why**: ${unknownExplanation(item)}`]))
}

/** A `###` entry for one whole Symbol: heading, file line, `extraRows`, then the L2 block. */
function symbolEntry(symbol: IRSymbol, extraRows: readonly string[]): string[] {
  return [
    `### ${inlineCode(symbol.name)} *(${symbol.kind})*`,
    `**File**: ${inlineCode(`${symbol.source.file}:${symbol.source.startLine}`)}`,
    ...extraRows,
    ...renderSymbolBlock(symbol).slice(1),
    "",
  ]
}

function unknownExplanation(item: SymbolUnknown): string {
  const side = item.absentFrom
  const fate = side === "head" ? "may still exist" : "may not be new"
  return `the ${side} scan skipped ${inlineCode(item.symbol.source.file)} (${item.reason}), so this Symbol ${fate}`
}

/**
 * Files neither revision analysed. Beside Unknown rather than inside it: an Unknown Symbol
 * needs one revision re-scanned, while a file here is a standing property of the workspace
 * every diff will keep missing. Both reasons, never one — `parse-timeout` at the base and
 * `over-size` at the head says whether a re-run is enough, which neither half does alone.
 */
function renderNotCompared(files: readonly NotComparedFile[]): string[] {
  if (files.length === 0) return []
  const rows: string[] = []
  for (const file of files) {
    const reasons =
      file.baseReason === file.headReason
        ? `${file.baseReason} on both`
        : `${file.baseReason} at base, ${file.headReason} at head`
    rows.push(`- ${inlineCode(file.path)} — ${reasons}`)
  }
  rows.push("")
  return rows
}

function renderMovedChanged(items: readonly SymbolMovedChanged[]): string[] {
  if (items.length === 0) return []
  const rows: string[] = []
  for (const item of sortByAfterId(items)) {
    rows.push(`### ${inlineCode(item.after.name)} *(${item.after.kind})*`)
    rows.push(
      `**Moved**: ${inlineCode(item.before.source.file)} → ${inlineCode(item.after.source.file)} (${inlineCode(item.rationale)})`,
    )
    rows.push("**Delta**:")
    rows.push(...renderDeltaBody(item.delta))
    rows.push("")
  }
  return rows
}

function renderMoved(items: readonly SymbolMoved[]): string[] {
  return sortByAfterId(items).map(
    (entry) =>
      `- ${inlineCode(entry.after.name)}: ${inlineCode(entry.before.source.file)} → ${inlineCode(entry.after.source.file)} (${inlineCode(entry.rationale)})`,
  )
}

function renderDroppedToggled(items: readonly SymbolDroppedToggled[]): string[] {
  const toDropped = items.filter((entry) => entry.direction === "to-dropped")
  const toKept = items.filter((entry) => entry.direction === "to-kept")
  const rows: string[] = []
  if (toDropped.length > 0) {
    rows.push(`**${toDropped.length} to-dropped**`)
    for (const entry of sortByAfterId(toDropped)) {
      rows.push(`- ${inlineCode(entry.after.id)} — ${requireDropReason(entry.after)}`)
    }
  }
  if (toKept.length > 0) {
    if (rows.length > 0) rows.push("")
    rows.push(`**${toKept.length} to-kept**`)
    for (const entry of sortByAfterId(toKept)) {
      rows.push(`- ${inlineCode(entry.after.id)}`)
    }
  }
  return rows
}

function renderSyntaxOnly(items: readonly (SymbolChanged | SymbolMovedChanged)[]): string[] {
  return sortByAfterId(items).map(
    (entry) =>
      `- ${inlineCode(entry.after.name)} (${inlineCode(`${entry.after.source.file}:${entry.after.source.startLine}`)})`,
  )
}

/**
 * slice-view.md — the Slice View section: every non-singleton Slice as a `###` subsection
 * with member bullets, then the singletons folded into one "Standalone changes" `<details>`.
 * Empty input renders nothing. `symbols[]` supplies each member's SymbolChange for the
 * per-bullet detail.
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
  for (const slice of nonSingleton) {
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
      // members[0] is the Slice anchor (slice-view.md). Read from members, never by
      // stripping the `slice:` prefix off `id`: for a record that broke the derivation that
      // would name a Symbol outside the Slice. (`sliceAnchor` lives in @aburi/diff, which
      // this package does not depend on.)
      const memberId = slice.members[0]
      if (memberId === undefined) {
        throw new Error(
          `projectDiff: slice ${slice.id} has an empty members[]; every Slice has at least one ` +
            "member and members[0] is its anchor (slice-view.md).",
        )
      }
      const label = renderSingletonLabel(memberId, slice.id, changeById)
      rows.push(`- ${inlineCode(slice.id)} — ${label}`)
    }
    rows.push("")
    rows.push("</details>")
  }
  return rows
}

/**
 * slice-view.md — one non-singleton Slice: the full slice id in a code span (so viewers do
 * not auto-link the `:` / `/` / `#`) with the member count, then a three-line cluster per
 * member.
 */
function renderSliceSection(
  slice: SliceRecord,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): string[] {
  const rows: string[] = []
  rows.push(`### ${inlineCode(slice.id)} (${slice.members.length} members)`)
  rows.push("")
  for (const memberId of slice.members) {
    const change = requireChangeForMember(memberId, slice.id, changeById)
    const symbol = symbolForMember(change)
    rows.push(`- ${inlineCode(symbol.name)} — *(${change.status})*`)
    rows.push(`  **File**: ${inlineCode(`${symbol.source.file}:${symbol.source.startLine}`)}`)
    rows.push(`  ↳ ${renderMemberFollowup(change)}${unresolvedCallMarker(symbol)}`)
  }
  rows.push("")
  return rows
}

/**
 * The note that turns slice-view.md's silent drop into something a reviewer can act on: an
 * unresolved call emits no `CallEdge`, so a Slice that should have bridged two Symbols may
 * show as two singletons. Counting the members' own `calls[].resolved` is sufficient, since
 * the Edge set draws an edge only when both endpoints are Nodes.
 */
function renderUnresolvedCallNote(
  slices: readonly SliceRecord[],
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
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
    `> ⚠ ${affectedMembers} of the changed symbols below ${verb} ${calls} the resolver could not identify, so a Slice here may be split rather than genuinely disconnected (call-resolution.md).`,
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
  memberId: SymbolId,
  sliceId: SliceId,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): string {
  const change = requireChangeForMember(memberId, sliceId, changeById)
  const symbol = symbolForMember(change)
  return `${inlineCode(symbol.name)} *(${change.status})*${unresolvedCallMarker(symbol)}`
}

/**
 * Every Slice member is a Node (slice-view.md) and every Node is a SymbolChange in
 * `diff.symbols[]` (its emission rules), so a missing entry is a producer bug that surfaces
 * here rather than as an "unknown" label.
 */
function requireChangeForMember(
  memberId: SymbolId,
  sliceId: SliceId,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): SymbolChange {
  const change = changeById.get(memberId)
  if (change === undefined) {
    throw new Error(
      `projectDiff: slice ${sliceId} lists member ${memberId} that is not present in diff.symbols[]; ` +
        `every Slice member must have a corresponding SymbolChange (slice-view.md).`,
    )
  }
  return change
}

/**
 * The Symbol a change is reported under (slice-view.md's Node set): `after` where both
 * sides exist, otherwise the one side the document holds. Pure `moved` is not a Node but is
 * still indexed.
 *
 * A `switch` rather than the two-way test it reduces to, because the two-way test is a
 * silent default: a status added to `SymbolChange` later that happens to carry an `after`
 * would compile and be reported under the wrong side of itself, with nothing to catch it.
 * Spelling out every status makes the addition a compile error at the one place that has to
 * decide which Symbol the new status is about.
 */
function symbolForMember(change: SymbolChange): IRSymbol {
  switch (change.status) {
    case "added":
    case "removed":
    case "unknown":
      return change.symbol
    case "changed":
    case "moved+changed":
    case "dropped-toggled":
    case "moved":
      return change.after
    default:
      return assertNeverChange(change)
  }
}

function renderMemberFollowup(change: SymbolChange): string {
  switch (change.status) {
    case "added":
      return "new symbol"
    case "removed":
      return "removed symbol"
    case "moved":
      return `moved: ${inlineCode(change.before.source.file)} → ${inlineCode(change.after.source.file)}`
    case "changed":
    case "moved+changed":
      return deltaAxisSummary(change.delta)
    case "dropped-toggled":
      return `dropped-toggled: ${change.direction}`
    case "unknown":
      return `unknown: the ${change.absentFrom} scan skipped this file (${change.reason})`
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

function indexChangesById(symbols: readonly SymbolChange[]): Map<SymbolId, SymbolChange> {
  const map = new Map<SymbolId, SymbolChange>()
  for (const change of symbols) map.set(symbolForMember(change).id, change)
  return map
}

function renderComponentChanges(diff: DiffResult): string[] {
  const rows: string[] = []
  if (diff.components.added.length > 0) {
    rows.push("### Added")
    for (const c of [...diff.components.added].sort((a, b) => compareStrings(a.id, b.id))) {
      rows.push(`- ${inlineCode(c.id)} — roots: ${c.roots.map((r) => inlineCode(r)).join(", ")}`)
    }
    rows.push("")
  }
  if (diff.components.removed.length > 0) {
    rows.push("### Removed")
    for (const c of [...diff.components.removed].sort((a, b) => compareStrings(a.id, b.id))) {
      rows.push(`- ${inlineCode(c.id)}`)
    }
    rows.push("")
  }
  if (diff.components.changed.length > 0) {
    rows.push("### Changed")
    for (const ch of diff.components.changed) {
      const fields = changedComponentFields(ch.before, ch.after)
      // Two documents can differ in a field neither this version nor the key sweep's
      // normalization recognises; naming the component alone is the honest row.
      rows.push(
        fields.length === 0
          ? `- ${inlineCode(ch.after.id)}`
          : `- ${inlineCode(ch.after.id)}: ${fields.join(", ")}`,
      )
    }
    rows.push("")
  }
  return rows
}

/**
 * The fields that differ between the two revisions of one Component, read from `before` /
 * `after` rather than `delta`: the delta summarises three axes, and a change to name,
 * languages or description leaves all three `false` (diff-algorithm.md). Scalars carry
 * their before → after inline through `inlineCode` (free-form config text that reaches a PR
 * comment body); list fields name themselves. The sweep after the six named fields covers a
 * `Component` key added to `aburi.ir.v1` later, which `diffComponents` will report and this
 * version has never heard of.
 */
function changedComponentFields(before: Component, after: Component): string[] {
  const fields: string[] = []
  if (before.name !== after.name) {
    fields.push(`name (${inlineCode(before.name)} → ${inlineCode(after.name)})`)
  }
  if (!sameList(before.roots, after.roots)) fields.push("roots")
  if (!sameList(before.publicApi ?? [], after.publicApi ?? [])) fields.push("publicApi")
  if (!sameList(before.languages, after.languages)) fields.push("languages")
  if (!sameList(before.frameworks ?? [], after.frameworks ?? [])) fields.push("frameworks")
  // Class A (ir-schema.md): an absent key and `null` are the same answer, so the `??`
  // is what keeps an older document that omits the key from reading as a description removal.
  const beforeDescription = before.description ?? null
  const afterDescription = after.description ?? null
  if (beforeDescription !== afterDescription) {
    fields.push(
      `description (${renderDescription(beforeDescription)} → ${renderDescription(afterDescription)})`,
    )
  }
  fields.push(...unknownChangedFields(before, after))
  return fields
}

/**
 * Field names the two revisions disagree on that `changedComponentFields` has no rendering
 * for. Compared by `JSON.stringify`, since the canonical serializer lives in `@aburi/core`
 * and is not a dependency here; the difference only shows on key order or Unicode form, as a
 * named field a reader can check.
 */
function unknownChangedFields(before: Component, after: Component): string[] {
  // Widened through `unknown`: the keys being read are by definition not on `Component`.
  const beforeRecord = before as unknown as Record<string, unknown>
  const afterRecord = after as unknown as Record<string, unknown>
  const names = new Set<string>()
  for (const key of [...Object.keys(beforeRecord), ...Object.keys(afterRecord)]) {
    if (key === "id" || RENDERED_COMPONENT_FIELDS.has(key)) continue
    if (normalizeUnknown(beforeRecord[key]) !== normalizeUnknown(afterRecord[key])) names.add(key)
  }
  return [...names].sort(compareStrings)
}

/** Absence, `null` and `[]` all read as "no value", matching the diff layer's normalization. */
function normalizeUnknown(value: unknown): string {
  // `absent` unquoted is unreachable as JSON: a string serializes with its quotes.
  if (value === undefined || value === null) return "absent"
  if (Array.isArray(value) && value.length === 0) return "absent"
  return JSON.stringify(value)
}

const RENDERED_COMPONENT_FIELDS = new Set<string>([
  "name",
  "roots",
  "publicApi",
  "languages",
  "frameworks",
  "description",
])

/**
 * A description as a row cell. `null` and `""` are different answers from the config author —
 * "no description" against "a description that is empty" — so they read differently here.
 */
function renderDescription(description: string | null): string {
  return description === null ? "none" : inlineCode(description)
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i])
}

/**
 * Dependency changes (markdown-projection.md) — split into component-level (architectural)
 * and symbol-level (implementation) groups under one heading; an empty group collapses. The
 * Unknown group appended last is not level-routed, because only a Symbol endpoint has a file
 * to lose.
 */
function renderDependencyChanges(diff: DiffResult): string[] {
  const { added, removed } = diff.dependencies
  const rows: string[] = []
  appendDependencyGroup(
    rows,
    "Component-level added",
    added.filter((d) => !isSymbolEdge(d)),
  )
  appendDependencyGroup(
    rows,
    "Component-level removed",
    removed.filter((d) => !isSymbolEdge(d)),
  )
  appendDependencyGroup(rows, "Symbol-level added", added.filter(isSymbolEdge))
  appendDependencyGroup(rows, "Symbol-level removed", removed.filter(isSymbolEdge))
  // `?? []` for a `diff.json` produced before the field existed: the alternative is a section
  // saying the diff might be incomplete on every older document, including the ones that
  // lost nothing.
  appendUnknownDependencies(rows, diff.dependencies.unknown ?? [])
  return rows
}

function appendDependencyGroup(rows: string[], heading: string, deps: readonly Dependency[]): void {
  if (deps.length === 0) return
  rows.push(`### ${heading}`)
  for (const d of deps) {
    rows.push(`- ${inlineCode(d.from)} → ${inlineCode(d.to)} (via ${inlineCode(d.via)})`)
  }
  rows.push("")
}

/**
 * Edges neither revision deleted, each with the lost file and reason, which is what tells a
 * reviewer whether to re-run (`parse-timeout`) or fix something (`parse-failed`).
 */
function appendUnknownDependencies(rows: string[], unknown: readonly DependencyUnknown[]): void {
  if (unknown.length === 0) return
  rows.push("### Unknown — the other revision never read one end")
  for (const entry of unknown) {
    const d = entry.dependency
    const lost = entry.lostFiles.map((f) => `${inlineCode(f.path)} (${f.reason})`).join(", ")
    rows.push(
      `- ${inlineCode(d.from)} → ${inlineCode(d.to)} (via ${inlineCode(d.via)}) — the ${entry.absentFrom} scan skipped ${lost}`,
    )
  }
  rows.push("")
}

function sortByAfterId<T extends { after: IRSymbol }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareStrings(a.after.id, b.after.id))
}
