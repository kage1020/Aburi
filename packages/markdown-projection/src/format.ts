import type {
  Call,
  Confidence,
  Decorator,
  DependencyEndpoint,
  Effect,
  Fingerprint,
  Symbol as IRSymbol,
  Rule,
  Signature,
} from "@aburi/types"

/**
 * Threshold above which a code fragment is broken out into a fenced block (§3.4). Inline
 * backticks below or at the threshold, fenced block above so PR comments stay compact.
 */
export const INLINE_CODE_MAX_LENGTH = 80

/**
 * §3.5 — confidence badge. `high` renders nothing so it does not visually compete with
 * the medium/low warnings; `medium` and `low` share the same `⚠` glyph but keep the
 * severity word so screen readers can distinguish them.
 */
export function confidenceBadge(value: Confidence): string {
  if (value === "high") return ""
  return ` ⚠ ${value}`
}

/**
 * §3.3 — POSIX-relative path wrapped in backticks. Callers are responsible for feeding a
 * pre-POSIX-normalised value; we do not re-normalise here to keep the projection layer
 * pure formatting.
 */
export function inlineCodePath(path: string): string {
  return inlineCode(path)
}

/**
 * §3.4 — inline vs. fenced choice. Anything ≤ `INLINE_CODE_MAX_LENGTH` and single-line
 * uses backticks; multiline strings ALWAYS render as fenced blocks so the newline
 * survives GitHub's Markdown pass without being folded into a single line.
 *
 * Both branches size their fence to the value: the inline one through `inlineCode`, the
 * block one through `fencedBlock`. A fixed three-backtick opener closes early on source
 * that itself contains a fence — a code sample inside a doc comment is enough — and the
 * remainder of the fragment lands in the document as Markdown.
 */
export function codeFragment(source: string, options: { forceFence?: boolean } = {}): string {
  const multiline = source.includes("\n")
  const forceFence = options.forceFence ?? false
  if (!forceFence && !multiline && source.length <= INLINE_CODE_MAX_LENGTH) {
    return inlineCode(source)
  }
  return `\n${fencedBlock(source)}\n`
}

/**
 * A fenced block whose opener clears the longest backtick run inside the source, and
 * whose every line — fences included — carries `indent`.
 *
 * The indent is what keeps a fence inside the list item that introduced it: CommonMark
 * ends a list item at the first non-blank line indented less than the item's content, so
 * a column-0 fence under `- guard:` closes the list rather than nesting in it. The same
 * prefix on the content lines is stripped back off at render time, because a fenced
 * block drops up to as much leading whitespace as its opening fence carried.
 */
export function fencedBlock(source: string, indent = ""): string {
  const fence = "`".repeat(Math.max(MIN_BLOCK_FENCE, longestBacktickRun(source) + 1))
  const body = source
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join("\n")
  return `${indent}${fence}\n${body}\n${indent}${fence}`
}

/** CommonMark's own minimum; `fencedBlock` only ever goes above it. */
const MIN_BLOCK_FENCE = 3

/** Two spaces: the content column of a `- ` list item. */
const LIST_ITEM_INDENT = "  "

/**
 * GFM resolves table cells before it parses inlines, so an unescaped `|` opens a column
 * the header row never declared and every cell after it shifts left — including inside a
 * code span, where a reader would expect the pipe to be literal. `\|` is the one escape
 * the table parser honours there, and it survives into the span as a bare pipe.
 *
 * A newline would end the row outright; `<br>` is GFM's in-cell line break, and matches
 * what the call-resolution table already uses to stack candidates.
 *
 * Takes rendered cell content, not a raw value — wrap in `inlineCode` first, then escape,
 * so the pipe inside the span is escaped too.
 */
export function tableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")
}

function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

/**
 * The one way this package embeds a value in a code span. Every row that shows a fragment of
 * somebody's source — a condition, an effect target, a call target, a path, a display name —
 * goes through here, because every one of those values can contain a backtick and a hand-written
 * `` `${value}` `` has no answer for it.
 *
 * A one-backtick span closes at the next one-backtick run, so a template literal —
 * `` key === `x-${plugin}:write` `` — splits the span and spills its interior into the
 * surrounding prose as Markdown. The fence is therefore one backtick longer than the longest run
 * inside the value, which is the CommonMark rule for embedding backticks rather than a trick.
 * The space padding is the same section's other half: a span whose content opens or closes with a
 * backtick or a space has one space stripped from each end, so the padding is what makes the
 * value render as written rather than a character short.
 *
 * Every newline run collapses to a single space, because a code span is one row by construction.
 * A value that deserves its own block is `codeFragment`'s, not this function's — a fenced block
 * cannot sit mid-row, and one that tries ends the list item it was written into.
 *
 * The empty string gets no span: `` renders as two literal backticks, not as an empty one. A
 * caller with a field that can be empty says so in words instead.
 */
export function inlineCode(value: string): string {
  const collapsed = value.replace(/\s*\r?\n\s*/g, " ")
  if (collapsed.length === 0) return ""
  const fence = "`".repeat(longestBacktickRun(collapsed) + 1)
  const edge = `${collapsed.at(0)}${collapsed.at(-1)}`
  const pad = edge.includes("`") || edge.includes(" ") ? " " : ""
  return `${fence}${pad}${collapsed}${pad}${fence}`
}

/**
 * The name this helper carried while the diff's component rows were its only caller.
 *
 * @deprecated Use `inlineCode`; this alias stays for consumers pinned to the old name.
 */
export const inlineCodeValue = inlineCode

/**
 * Read the `dropReason` off a dropped Symbol. The IR schema (aburi.ir.v1) enforces
 * `dropped=true → dropReason: string (minLength 1)`, so `null` here is an upstream
 * invariant violation the projection layer must surface loudly instead of quietly
 * emitting `— unspecified` in reviewer-facing Markdown.
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

/**
 * §3.6 — dropped fold-out. `entries` are pre-sorted lines that go inside the `<details>`
 * block; the summary count is derived from the array length.
 */
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
 * §5.4 — Decorator display. Boundary-only symbols render `**Boundary**` with the
 * pre-`@` prepended; mixed symbols show both rows. Empty arrays skip the row entirely per
 * §5.3.
 *
 * The returned value can be an empty string; callers should treat empty output as
 * "omit the row" rather than inserting a blank line, so section spacing stays tight.
 */
export function decoratorRows(decorators: readonly Decorator[]): string[] {
  const parts = splitDecorators(decorators)
  const rows: string[] = []
  if (parts.boundary !== null) rows.push(`**Boundary**: ${parts.boundary}`)
  if (parts.regular !== null) rows.push(`**Decorators**: ${parts.regular}`)
  return rows
}

/**
 * Structured variant of `decoratorRows`. Returns the boundary / regular decorator lists
 * as pre-rendered inline strings (or `null` when the corresponding bucket is empty), so
 * callers that render into different section shapes (§7 `aburi explain` layout, §6 diff
 * "decorator added" rows) do not have to re-parse the compact `**Boundary**: …` string
 * back into fields.
 */
export interface DecoratorLists {
  boundary: string | null
  regular: string | null
}

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
 * §5.5 — Signature rendering. Follows the design table:
 *   `(name: type, name: type) → output` + optional `throws A, B` + `⚡async` / `*generator*` /
 *   `<T,U>` badges. Multiple outputs are `|`-separated.
 *
 * Returns `null` when the caller passed no signature — that way §5.3 section-omit logic
 * can branch on presence without re-checking the raw field.
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
 * §5.6 — Rule row. Each RuleType renders differently so the reviewer can tell what
 * failed at a glance. Missing per-type payloads (a `guard` without `condition`, a `loop`
 * without `loopKind`, etc.) violate the IR contract in ir-schema §5.5 and throw
 * `ProjectionInvariantError` so an upstream extractor bug does not surface as
 * `- guard:  (L5)` in a reviewer's PR.
 *
 * `switch` exhaustiveness is enforced by the trailing `never` branch — adding a new
 * `RuleType` to the schema will produce a compile error here instead of a silent
 * "plain `<type>` (L<line>)" fallback.
 *
 * A value long enough to fence returns a multi-line row: `payloadRow` moves the line tag up
 * and indents the block under the item. See there for why the compact row cannot hold one.
 */
export function ruleRow(rule: Rule): string {
  const lineTag = `(L${rule.line})`
  switch (rule.type) {
    case "guard":
      return payloadRow("guard", requireField(rule, "condition"), rule.line)
    case "throw":
      return payloadRow("throw", requireField(rule, "what"), rule.line)
    case "return":
      return payloadRow("return", requireField(rule, "expr"), rule.line)
    case "loop":
      return `- loop (${inlineCode(requireField(rule, "loopKind"))}) ${lineTag}`
    case "try":
      return `- try ${lineTag}`
    case "switch":
      return payloadRow("switch", requireField(rule, "condition"), rule.line)
    case "match":
      return payloadRow("match", requireField(rule, "condition"), rule.line)
    default:
      return assertNeverRule(rule)
  }
}

/**
 * One rule row, in whichever of its two shapes the payload fits.
 *
 * `- guard: <code> (L5)` is the row §5.6 documents and the one nearly every rule takes.
 * It cannot hold a fenced block: the fence would open at column 0 in the middle of the
 * item, which CommonMark reads as the end of the list — the `(L5)` after it becomes a
 * paragraph of its own and the rules below it restart as a second list. And a fence is
 * exactly what a condition over `INLINE_CODE_MAX_LENGTH` asks for; a boolean guard that
 * long is routine, the IR truncates only past 120 characters.
 *
 * So a payload that fences takes the second shape, with the line tag moved ahead of the
 * colon — the block has to be last — and the fence indented into the item:
 *
 * ```md
 * - guard (L3):
 *   ```
 *   user.role === 'admin' && flags.enabled && !session.expired
 *   ```
 * ```
 *
 * The empty payload keeps the literal `` `` `` the row has always shown for it. It is not a
 * value the schema admits, and a row that renders nothing after its colon would say less
 * about the upstream bug than two backticks do.
 */
function payloadRow(label: string, value: string, line: number): string {
  if (value === "") return `- ${label}: \`\` (L${line})`
  if (!value.includes("\n") && value.length <= INLINE_CODE_MAX_LENGTH) {
    return `- ${label}: ${inlineCode(value)} (L${line})`
  }
  return `- ${label} (L${line}):\n${fencedBlock(value, LIST_ITEM_INDENT)}`
}

/**
 * Raised when the projection layer encounters a Symbol/Rule/... whose IR-mandatory field
 * is missing. The `field` is the schema name so error messages remain greppable in CI
 * logs, and `subject` is a diagnostic identifier (usually the Rule's line + type combo).
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
  // `rule.type` is narrowed to `never` inside the default branch when every RuleType
  // discriminant is handled by the switch above, so this line only compiles if the
  // union is fully covered — TypeScript's assertNever pattern applied to a nested
  // discriminant.
  const exhaustive: never = rule.type as never
  throw new ProjectionInvariantError("type", `Rule(type=${JSON.stringify(exhaustive)})`)
}

/**
 * §5.7 — Effect row. Format: `- <id>: \`<target>\` (L<line>) [<plugin>]<confidence-badge>`.
 * Extension effects (`x-<plugin>:<name>`) use the same shape — no special-casing needed
 * because id/target/plugin/confidence are all schema-mandatory.
 *
 * Propagated entries (effect-propagation.md §5.1) omit `line`; the row substitutes a
 * `[propagated from <sorted derivedFrom>]` marker in its place, so a reviewer can trace
 * the effect back to the direct callee that carried it into this Symbol.
 */
export function effectRow(eff: Effect): string {
  if (eff.propagated === true) {
    const derivedFrom = (eff.derivedFrom ?? []).join(", ")
    return `- ${eff.id}: ${inlineCode(eff.target)} [propagated from ${derivedFrom}] [${eff.plugin}]${confidenceBadge(eff.confidence)}`
  }
  return `- ${eff.id}: ${inlineCode(eff.target)} (L${eff.line}) [${eff.plugin}]${confidenceBadge(eff.confidence)}`
}

/**
 * §5.8 — Call row. The row shape is deliberately identical whether or not `resolved` is
 * populated; the `resolved` Symbol id is not rendered yet because the anchor scheme
 * for cross-Symbol links inside a single Markdown file is not finalised. Emitting the
 * resolved id here now would create PR churn when that scheme lands.
 */
export function callRow(callObj: Call): string {
  return `- ${inlineCode(callObj.target)} (L${callObj.line})`
}

/**
 * §5.9 — Fingerprint one-liner. Rendered inside `<sub>` so it does not compete for
 * attention. `null` returned for dropped Symbols (all-zero fingerprint) so §5.3 can omit
 * the row instead of emitting `<sub>api=\`000...\` ...\`</sub>` noise.
 */
export function fingerprintLine(fp: Fingerprint): string | null {
  if (isZeroFingerprint(fp)) return null
  return `<sub>api=${inlineCode(fp.api)} logic=${inlineCode(fp.logic)} syntax=${inlineCode(fp.syntax)}</sub>`
}

function isZeroFingerprint(fp: Fingerprint): boolean {
  return fp.api === ZERO && fp.logic === ZERO && fp.syntax === ZERO
}

const ZERO = "000000000000"

/**
 * §5.2 heading pattern. `id`-derived slug is not needed here — the human-readable name +
 * kind combo is enough for readers scanning the file.
 */
export function symbolHeading(symbol: IRSymbol): string {
  return `#### ${inlineCode(symbol.name)} *(${symbol.kind})*`
}

/**
 * §3.2 — canonical ordering for a set of Symbols. `startLine` primary key, `id`
 * tiebreaker; sorting is stable across runs because `Array.prototype.sort` uses stable
 * order in modern JS engines.
 */
export function orderSymbolsWithinFile(symbols: readonly IRSymbol[]): IRSymbol[] {
  return [...symbols].sort((a, b) => {
    if (a.source.startLine !== b.source.startLine) return a.source.startLine - b.source.startLine
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** §3.2 — file grouping preserves POSIX ordering per §3.3. */
export function orderFilesAscending(files: readonly string[]): string[] {
  return [...files].sort(compareStrings)
}

/**
 * Three-value string comparator. The two-value form `a < b ? -1 : 1` is subtly wrong:
 * equal strings still return `1`, which destabilises `Array.prototype.sort` on ties even
 * though the algorithm itself is stable. Every string-key sort in this package routes
 * through here so the tiebreak stays deterministic.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * ir-schema.md §3.1 Symbol id shape (`<language>:<file>#<qname>`). Kept as a
 * private constant so this module's helpers do not need to re-import the same
 * pattern from `@aburi/core` — the two definitions are pin-linked to the
 * schema and would drift in lockstep on any future change.
 */
const SYMBOL_ID_PATTERN = /^[a-z][a-z0-9]*:[^#]+#.+$/

/**
 * True when a Dependency endpoint (from/to) matches the Symbol id shape rather
 * than the Component id shape. Used to route symbol-to-symbol call edges
 * through their dedicated Markdown sections while leaving component-to-component
 * edges in the existing sections.
 *
 * Takes a `DependencyEndpoint` — the union of both id kinds — but answers with a plain
 * boolean rather than narrowing to `SymbolId`. The pattern here is deliberately looser than
 * the `isSymbolId` constructor-equivalent in `@aburi/core` (no backslash exclusion), so
 * narrowing would hand the brand to strings `makeSymbolId` refuses and break the property
 * the brand exists to carry: that holding a `SymbolId` means having gone through a
 * constructor. Callers use this to route an endpoint into a section, not to prove anything
 * about it.
 */
export function isSymbolIdEndpoint(endpoint: DependencyEndpoint): boolean {
  return SYMBOL_ID_PATTERN.test(endpoint)
}
