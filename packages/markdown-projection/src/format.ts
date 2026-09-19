import type {
  Call,
  Confidence,
  Decorator,
  Dependency,
  DependencyEndpoint,
  Effect,
  Fingerprint,
  Symbol as IRSymbol,
  Rule,
  Signature,
} from "@aburi/types"

/** A code fragment longer than this is a fenced block, so PR comments stay compact. */
export const INLINE_CODE_MAX_LENGTH = 80

/**
 * markdown-projection.md — confidence badge. `high` renders nothing so it does not compete
 * with the warnings;
 * `medium` and `low` share the `⚠` glyph but keep the severity word for screen readers.
 */
export function confidenceBadge(value: Confidence): string {
  if (value === "high") return ""
  return ` ⚠ ${value}`
}

/**
 * markdown-projection.md — POSIX-relative path wrapped in backticks.
 *
 * @deprecated Use `inlineCode`, which this forwards to unchanged. Removed in 1.0.0.
 */
export function inlineCodePath(path: string): string {
  return inlineCode(path)
}

/**
 * markdown-projection.md — inline vs. fenced choice. Anything `fitsInline` accepts uses
 * backticks; everything else renders as a fenced block so the newline survives GitHub's
 * Markdown pass. Both
 * branches size their fence to the value. `indent` is forwarded to `fencedBlock` and matters:
 * a column-0 fence inside a list item ends the item rather than nesting in it (`payloadRow`
 * is the worked example).
 */
export function codeFragment(
  source: string,
  options: { forceFence?: boolean; indent?: string } = {},
): string {
  const forceFence = options.forceFence ?? false
  const indent = options.indent ?? ""
  if (!forceFence && fitsInline(source)) return inlineCode(source)
  return `\n${fencedBlock(source, indent)}\n`
}

/** The inline threshold: single-line and no longer than `INLINE_CODE_MAX_LENGTH`. */
export function fitsInline(value: string): boolean {
  return !value.includes("\n") && value.length <= INLINE_CODE_MAX_LENGTH
}

/**
 * Every line ending CommonMark recognises, including a lone carriage return. Splitting on
 * `\n` alone would leave a lone `\r` inside what the code here treats as one line.
 */
const LINE_ENDING = /\r\n|\r|\n/

/**
 * A fenced block whose opener clears the longest backtick run inside the source, and whose
 * every line — fences included — carries `indent`. The indent keeps a fence inside the list
 * item that introduced it: CommonMark ends a list item at the first non-blank line indented
 * less than the item's content. The renderer strips the prefix back off the content lines,
 * because a fenced block drops up to as much leading whitespace as its opening fence carried.
 */
export function fencedBlock(source: string, indent = ""): string {
  const fence = "`".repeat(Math.max(MIN_BLOCK_FENCE, longestBacktickRun(source) + 1))
  // A blank line stays empty: indenting it would write trailing whitespace a linter reports.
  const body = source
    .split(new RegExp(LINE_ENDING, "g"))
    .map((line) => (line === "" ? "" : `${indent}${line}`))
    .join("\n")
  return `${indent}${fence}\n${body}\n${indent}${fence}`
}

/** CommonMark's own minimum; `fencedBlock` only ever goes above it. */
const MIN_BLOCK_FENCE = 3

/** Two spaces: the content column of a `- ` list item. */
const LIST_ITEM_INDENT = "  "

/** One GFM row. Every cell is escaped here and nowhere else, so none is escaped twice or not at all. */
export function tableRow(cells: readonly string[]): string {
  return `| ${cells.map(tableCell).join(" | ")} |`
}

/** A header row with its delimiter row, emitted together so their column counts cannot drift. */
export function tableHeader(cells: readonly string[]): string[] {
  return [tableRow(cells), `|${cells.map(() => "---").join("|")}|`]
}

/**
 * GFM resolves table cells before it parses inlines, so an unescaped `|` — even inside a code
 * span — opens a column the header never declared. `\|` is what the row scanner reads as a
 * literal pipe. The backslash run directly before a pipe is doubled first, following
 * cmark-gfm's escape grammar: the scanner reads a backslash and the punctuation after it as
 * one escape pair, so in a value already carrying `\|` a naive escape produces `\\|` and the
 * pipe is a delimiter again. A line ending would end the row outright, so it becomes `<br>`.
 *
 * Takes rendered cell content, not a raw value — wrap in `inlineCode` first, then escape.
 */
export function tableCell(text: string): string {
  return text
    .replace(/(\\*)\|/g, (_, slashes: string) => `${slashes}${slashes}\\|`)
    .replace(new RegExp(LINE_ENDING, "g"), "<br>")
}

function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

/**
 * What a value renders as when it has nothing in it. Emitting nothing instead is
 * indistinguishable from the field being absent, and one level up it deletes the row.
 */
export const EMPTY_VALUE = "(empty)"

/**
 * The one way this package embeds a value in a code span, because every value it shows can
 * contain a backtick and a hand-written `` `${value}` `` has no answer for one.
 *
 * The fence is one backtick longer than the longest run inside the value — CommonMark's own
 * rule for embedding backticks. The space padding covers two rules of the same spec: a value
 * that opens or closes with a backtick needs a space to keep its backtick out of the delimiter
 * run, and the parser strips one space from each end only when the content both begins and
 * ends with one, so the padding goes on both ends or neither (an all-space value is the one
 * input this cannot round-trip). Newline runs collapse to a space, because a code span is one
 * row by construction; a value that deserves a block is `codeFragment`'s. The empty string
 * has no code span — `` is two literal backticks — so it renders as `EMPTY_VALUE`.
 */
export function inlineCode(value: string): string {
  const collapsed = value.replace(new RegExp(`\\s*(?:${LINE_ENDING.source})\\s*`, "g"), " ")
  if (collapsed.length === 0) return EMPTY_VALUE
  const fence = "`".repeat(longestBacktickRun(collapsed) + 1)
  const edge = `${collapsed.at(0)}${collapsed.at(-1)}`
  const pad = edge.includes("`") || edge.includes(" ") ? " " : ""
  return `${fence}${pad}${collapsed}${pad}${fence}`
}

/** @deprecated Renamed to `inlineCode`. Kept for consumers pinned to 0.3.x; removed in 1.0.0. */
export const inlineCodeValue = inlineCode

/**
 * The `dropReason` of a dropped Symbol. The schema enforces `dropped=true → dropReason:
 * string (minLength 1)`, so `null` here is an upstream invariant violation to surface loudly
 * rather than render as `— unspecified`.
 */
export function requireDropReason(symbol: {
  id: string
  dropped: boolean
  dropReason: string | null | undefined
}): string {
  if (symbol.dropReason === null || symbol.dropReason === undefined || symbol.dropReason === "") {
    throw new ProjectionInvariantError("dropReason", `Symbol(id=${symbol.id}, dropped=true)`)
  }
  return symbol.dropReason
}

/** Dropped fold-out over pre-sorted entry lines; empty input renders nothing. */
export function droppedFoldout(entries: readonly string[]): string {
  if (entries.length === 0) return ""
  const body = entries.map((line) => `- ${line}`).join("\n")
  return [
    "## Dropped",
    "",
    "<details>",
    `<summary>${entries.length} dropped symbols</summary>`,
    "",
    body,
    "",
    "</details>",
    "",
  ].join("\n")
}

/**
 * markdown-projection.md — decorator rows: `**Boundary**` for boundary decorators,
 * `**Decorators**` for the rest, each omitted when its bucket is empty.
 */
export function decoratorRows(decorators: readonly Decorator[]): string[] {
  const parts = splitDecorators(decorators)
  const rows: string[] = []
  if (parts.boundary !== null) rows.push(`**Boundary**: ${parts.boundary}`)
  if (parts.regular !== null) rows.push(`**Decorators**: ${parts.regular}`)
  return rows
}

/** The two decorator buckets as pre-rendered inline strings, `null` where a bucket is empty. */
export interface DecoratorLists {
  boundary: string | null
  regular: string | null
}

/**
 * Structured variant of `decoratorRows`, for callers rendering into other section shapes
 * (`aburi explain`, diff rows) so they need not re-parse the compact row.
 */
export function splitDecorators(decorators: readonly Decorator[]): DecoratorLists {
  if (decorators.length === 0) return { boundary: null, regular: null }
  const boundary = decorators.filter((d) => d.boundary)
  const regular = decorators.filter((d) => !d.boundary)
  return {
    boundary: boundary.length === 0 ? null : renderDecoratorList(boundary),
    regular: regular.length === 0 ? null : renderDecoratorList(regular),
  }
}

export function renderDecoratorList(decorators: readonly Decorator[]): string {
  return decorators.map((d) => inlineCode(`@${d.raw}`)).join(" ")
}

/**
 * markdown-projection.md — `(name: type) → output` + optional `throws A, B` + `⚡async` /
 * `*generator*` / `<T,U>` badges; multiple outputs are `|`-separated. `null` when there is
 * no signature, so the section-omit logic can branch on presence.
 */
export function signatureLine(signature: Signature | null | undefined): string | null {
  if (signature === null || signature === undefined) return null
  const inputs = signature.inputs.map((i) => `${i.name}: ${i.type}`).join(", ")
  const outputs = signature.outputs.length > 0 ? signature.outputs.join(" | ") : "void"
  const throwsPart = signature.throws.length > 0 ? ` throws ${signature.throws.join(", ")}` : ""
  const asyncBadge = signature.async ? " ⚡async" : ""
  const genBadge = signature.generator ? " *generator*" : ""
  const typeParams =
    signature.typeParameters.length > 0 ? `<${signature.typeParameters.join(",")}>` : ""
  return `${inlineCode(`${typeParams}(${inputs}) → ${outputs}`)}${throwsPart}${asyncBadge}${genBadge}`
}

/**
 * markdown-projection.md — Rule row, as the lines it occupies (a payload long enough to
 * fence takes four, and callers spread into a `string[]` joined by newline). A missing
 * per-type payload violates ir-schema.md's extraction conventions and throws
 * `ProjectionInvariantError` rather than rendering `- guard:  (L5)`.
 * The label is `rule.type` itself, and the `never` branch keeps the switch exhaustive.
 */
export function ruleRow(rule: Rule): string[] {
  const lineTag = `(L${rule.line})`
  switch (rule.type) {
    case "guard":
    case "switch":
    case "match":
      return payloadRow(rule.type, requireField(rule, "condition"), rule.line)
    case "throw":
      return payloadRow(rule.type, requireField(rule, "what"), rule.line)
    case "return":
      return payloadRow(rule.type, requireField(rule, "expr"), rule.line)
    case "loop":
      return [`- loop (${inlineCode(requireField(rule, "loopKind"))}) ${lineTag}`]
    case "try":
      return [`- try ${lineTag}`]
    default:
      return assertNeverRule(rule)
  }
}

/**
 * One rule row in whichever of its two shapes the payload fits: `- guard: <code> (L5)`, or,
 * for a payload that fences, `- guard (L5):` with the block indented into the item and last
 * (a column-0 fence mid-item would end the list). An empty payload renders as `EMPTY_VALUE`:
 * `Rule.condition` / `what` / `expr` carry no `minLength`, so it is a document to render, not
 * an invariant to throw on.
 */
function payloadRow(label: string, value: string, line: number): string[] {
  if (fitsInline(value)) return [`- ${label}: ${inlineCode(value)} (L${line})`]
  return [`- ${label} (L${line}):`, ...fencedBlock(value, LIST_ITEM_INDENT).split("\n")]
}

/**
 * Raised when a Symbol/Rule/... lacks an IR-mandatory field. `field` is the schema name so
 * messages stay greppable in CI logs; `subject` identifies the record.
 */
export class ProjectionInvariantError extends Error {
  readonly field: string
  readonly subject: string
  constructor(field: string, subject: string) {
    super(`markdown-projection invariant violated: ${field} required on ${subject}`)
    this.name = "ProjectionInvariantError"
    this.field = field
    this.subject = subject
  }
}

function requireField(rule: Rule, field: "condition" | "what" | "expr" | "loopKind"): string {
  const value = rule[field]
  if (value === null || value === undefined) {
    throw new ProjectionInvariantError(field, `Rule(type=${rule.type}, line=${rule.line})`)
  }
  return value
}

function assertNeverRule(rule: Rule): never {
  const exhaustive: never = rule.type as never
  throw new ProjectionInvariantError("type", `Rule(type=${JSON.stringify(exhaustive)})`)
}

/**
 * markdown-projection.md — Effect row: `- <id>: \`<target>\` (L<line>) [<plugin>]<badge>`.
 * Propagated entries (effect-propagation.md) omit `line`; the row substitutes
 * `[propagated from …]` so a reviewer can trace the effect to the direct callee that carried
 * it in.
 */
export function effectRow(eff: Effect): string {
  if (eff.propagated === true) {
    const derivedFrom = (eff.derivedFrom ?? []).join(", ")
    return `- ${eff.id}: ${inlineCode(eff.target)} [propagated from ${derivedFrom}] [${eff.plugin}]${confidenceBadge(eff.confidence)}`
  }
  return `- ${eff.id}: ${inlineCode(eff.target)} (L${eff.line}) [${eff.plugin}]${confidenceBadge(eff.confidence)}`
}

/**
 * Emission order of a Symbol's effects (effect-propagation.md): local entries by line,
 * then propagated ones — which omit `line` — by `(id, target)`. A single-key sort by
 * `line ?? 0` would put every propagated entry first.
 */
export function orderEffects(effects: readonly Effect[]): Effect[] {
  const locals = effects
    .filter((e) => e.propagated !== true)
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  const propagated = effects.filter((e) => e.propagated === true).sort(compareEffectIdentity)
  return [...locals, ...propagated]
}

/** `(id, target)` order — the whole of an effect's identity. */
export function compareEffectIdentity(a: Effect, b: Effect): number {
  return compareStrings(a.id, b.id) || compareStrings(a.target, b.target)
}

/**
 * markdown-projection.md — Call row. `resolved` is not rendered yet because the anchor
 * scheme for cross-Symbol links inside one Markdown file is not finalised; emitting it now
 * would create PR churn.
 */
export function callRow(call: Call): string {
  return `- ${inlineCode(call.target)} (L${call.line})`
}

/**
 * markdown-projection.md — Fingerprint one-liner inside `<sub>`. `null` for a dropped Symbol
 * (all-zero fingerprint) so the section-omit rules can omit the row.
 */
export function fingerprintLine(fp: Fingerprint): string | null {
  if (isZeroFingerprint(fp)) return null
  return `<sub>api=${inlineCode(fp.api)} logic=${inlineCode(fp.logic)} syntax=${inlineCode(fp.syntax)}</sub>`
}

function isZeroFingerprint(fp: Fingerprint): boolean {
  return (
    fp.api === ZERO_FINGERPRINT && fp.logic === ZERO_FINGERPRINT && fp.syntax === ZERO_FINGERPRINT
  )
}

const ZERO_FINGERPRINT = "000000000000"

/** Symbol heading: name + kind is enough for a reader scanning the file. */
export function symbolHeading(symbol: IRSymbol): string {
  return `#### ${inlineCode(symbol.name)} *(${symbol.kind})*`
}

/** markdown-projection.md — canonical Symbol order within a file: `startLine`, then `id`. */
export function orderSymbolsWithinFile(symbols: readonly IRSymbol[]): IRSymbol[] {
  return [...symbols].sort(
    (a, b) => a.source.startLine - b.source.startLine || compareStrings(a.id, b.id),
  )
}

/** markdown-projection.md — file grouping preserves the POSIX path ordering. */
export function orderFilesAscending(files: readonly string[]): string[] {
  return [...files].sort(compareStrings)
}

/**
 * Three-value string comparator. The two-value form `a < b ? -1 : 1` returns `1` for equal
 * strings, which destabilises `Array.prototype.sort` on ties. Every string-key sort in this
 * package routes through here.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Dependencies in `(from, to, via)` order — their identity (diff-algorithm.md). */
export function sortDependencies(deps: readonly Dependency[]): Dependency[] {
  return [...deps].sort(
    (a, b) =>
      compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.via, b.via),
  )
}

export interface RenderDocumentOptions {
  /**
   * Fold a run of three or more newlines back to one blank line. On by default: a renderer
   * that pushes a section's trailing `""` next to the following section's leading `""` writes
   * a double blank line the document never meant, and every renderer here is assembled that
   * way. Off for a renderer whose own spacing is fixed and whose lines carry a value
   * verbatim — there the fold can only ever reach somebody else's text (`renderDroppedExplain`
   * is the one such caller, and says why at its own definition).
   */
  readonly collapseBlankRuns?: boolean
}

/** A document's final bytes: collapsed blank runs, one trailing newline, `\n` throughout. */
export function renderDocument(
  lines: readonly string[],
  options: RenderDocumentOptions = {},
): string {
  const joined = lines.join("\n")
  const body = options.collapseBlankRuns === false ? joined : joined.replace(/\n{3,}/g, "\n\n")
  return `${body.trimEnd()}\n`
}

/**
 * ir-schema.md Symbol id shape (`<language>:<file>#<qname>`). Deliberately looser than
 * `isSymbolId` in `@aburi/core` (no backslash exclusion), which is why `isSymbolIdEndpoint`
 * answers with a boolean rather than narrowing to `SymbolId`: holding the brand means having
 * gone through a constructor, and this only routes an endpoint into a section.
 */
const SYMBOL_ID_PATTERN = /^[a-z][a-z0-9]*:[^#]+#.+$/

/** Whether an endpoint has the Symbol id silhouette rather than the Component id one. */
export function isSymbolIdEndpoint(endpoint: DependencyEndpoint): boolean {
  return SYMBOL_ID_PATTERN.test(endpoint)
}

/** Whether either end of a Dependency is a Symbol, which routes it to the symbol-level sections. */
export function isSymbolEdge(dependency: Dependency): boolean {
  return isSymbolIdEndpoint(dependency.from) || isSymbolIdEndpoint(dependency.to)
}
