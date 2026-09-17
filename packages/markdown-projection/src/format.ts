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
 *
 * @deprecated Use `inlineCode`, which this now forwards to unchanged — a path needs the same
 * fence widening as any other value, and nothing in the package calls this. Removed in 1.0.0.
 */
export function inlineCodePath(path: string): string {
  return inlineCode(path)
}

/**
 * §3.4 — inline vs. fenced choice. Anything `fitsInline` accepts uses backticks; everything
 * else renders as a fenced block so the newline survives GitHub's Markdown pass without
 * being folded into a single line.
 *
 * Both branches size their fence to the value: the inline one through `inlineCode`, the
 * block one through `fencedBlock`. A fixed three-backtick opener closes early on source
 * that itself contains a fence — a code sample inside a doc comment is enough — and the
 * remainder of the fragment lands in the document as Markdown.
 *
 * `indent` is forwarded to `fencedBlock` and is not optional detail: the block this returns
 * opens at whatever column the caller gives it, and at column 0 inside a list item it ends
 * the item rather than nesting in it (see `fencedBlock`). A caller rendering into a list
 * passes that item's content column; `payloadRow` is the worked example.
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

/**
 * §3.4's threshold, as one predicate rather than as the same two conditions written twice.
 * A value fits in a code span when it is single-line and no longer than
 * `INLINE_CODE_MAX_LENGTH`; anything else is a fenced block's.
 */
export function fitsInline(value: string): boolean {
  return !value.includes("\n") && value.length <= INLINE_CODE_MAX_LENGTH
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
/**
 * Every line ending CommonMark recognises: a newline, a carriage return with a newline after it,
 * and a lone carriage return, which is a line break too. Splitting on `\n` alone leaves a lone
 * `\r` inside what the code here treats as one line, and the renderer then breaks it anyway.
 */
const LINE_ENDING = /\r\n|\r|\n/

export function fencedBlock(source: string, indent = ""): string {
  const fence = "`".repeat(Math.max(MIN_BLOCK_FENCE, longestBacktickRun(source) + 1))
  // A blank line keeps its emptiness: indenting it would write trailing whitespace that
  // renders as nothing and that a Markdown linter reports on every one of them.
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

/**
 * One GFM row, from cells that have not been escaped yet. Every cell goes through `tableCell`
 * here and nowhere else, so a cell cannot reach a row unescaped and cannot be escaped twice —
 * both of which were constructable while three call sites each wrote `cells.map(tableCell)`
 * followed by their own join.
 */
export function tableRow(cells: readonly string[]): string {
  return `| ${cells.map(tableCell).join(" | ")} |`
}

/**
 * A header row and the delimiter row under it, which is the pair GFM needs to read the block
 * as a table at all. Emitted together because the delimiter has to carry exactly as many
 * columns as the header: written apart, the two counts drift, and a table whose delimiter is
 * one column short stops being a table.
 */
export function tableHeader(cells: readonly string[]): string[] {
  return [tableRow(cells), `|${cells.map(() => "---").join("|")}|`]
}

/**
 * GFM resolves table cells before it parses inlines, so an unescaped `|` opens a column the
 * header row never declared and every cell after it shifts left — including inside a code span,
 * where a reader would expect the pipe to be literal. `\|` is what the row scanner reads as a
 * literal pipe, and it survives into the span as a bare one.
 *
 * The backslash doubling in front of it is the same rule applied one step earlier. The scanner
 * reads a backslash and the punctuation after it as one escape pair, so in a value that already
 * carries `\|`, a naive escape produces `\\|` — the first backslash escapes the second, and the
 * pipe is a delimiter again. Doubling the backslash run that precedes the pipe makes those
 * backslashes pair up with each other and leaves the `\|` at the end to escape the pipe. Only a
 * run adjacent to a pipe is doubled, so a Windows-style path elsewhere in the cell is untouched.
 *
 * This follows cmark-gfm's escape grammar rather than an experiment: there is no Markdown parser
 * in this workspace to check it against. The cost is one visible backslash per doubled one inside
 * the code span, where no backslash is unescaped — a column that still lines up is worth more.
 *
 * A line ending would end the row outright — a lone carriage return counts as one, which is why
 * `LINE_ENDING` and not `\n` — and `<br>` is GFM's in-cell break, the same one the
 * call-resolution table already uses to stack candidates.
 *
 * Takes rendered cell content, not a raw value — wrap in `inlineCode` first, then escape, so the
 * pipe inside the span is escaped too.
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
 * What a value renders as when it has nothing in it. Named rather than spelled out at each
 * call site, because the alternative a renderer reaches for — emitting nothing — is
 * indistinguishable from the field being absent, and one level up it deletes the row that
 * was about to say so.
 */
export const EMPTY_VALUE = "(empty)"

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
 *
 * The space padding answers two different rules, and they are worth keeping apart:
 *   - A value that opens or closes with a backtick needs the padding to *exist*. Its own
 *     backtick would otherwise sit flush against the delimiter and extend that run, and a span
 *     whose opening and closing runs are both three backticks long against a value starting
 *     with one is no span at all — the delimiters are consumed and the value renders bare.
 *     CommonMark's own wording for this is that the space separates the content from the
 *     delimiter run.
 *   - Padding is safe because the parser strips one space from each end again — but only when
 *     the content *both* begins and ends with a space, and is not made entirely of spaces. That
 *     is why the padding goes on both ends or neither, and why an all-space value (a space
 *     renders as three) is the one input this cannot round-trip.
 *
 * Every newline run collapses to a single space, because a code span is one row by construction.
 * A value that deserves its own block is `codeFragment`'s, not this function's — a fenced block
 * cannot sit mid-row, and one that tries ends the list item it was written into unless it is
 * indented into it (`codeFragment`'s `indent`, and `payloadRow` for the worked example).
 *
 * The empty string has no code span — `` is two literal backticks, not an empty one — so it
 * renders as `EMPTY_VALUE`. Returning nothing instead is what this function used to do, and it
 * put every caller one step from a blank bullet, a heading with no text, or (through
 * `appendInlineRow`) a row dropped from the diff altogether. A caller that wants to say
 * something else about an empty field still can; what it cannot do is fail to notice.
 */
export function inlineCode(value: string): string {
  const collapsed = value.replace(new RegExp(`\\s*(?:${LINE_ENDING.source})\\s*`, "g"), " ")
  if (collapsed.length === 0) return EMPTY_VALUE
  const fence = "`".repeat(longestBacktickRun(collapsed) + 1)
  const edge = `${collapsed.at(0)}${collapsed.at(-1)}`
  const pad = edge.includes("`") || edge.includes(" ") ? " " : ""
  return `${fence}${pad}${collapsed}${pad}${fence}`
}

/**
 * @deprecated Renamed to `inlineCode`. The alias stays for consumers pinned to 0.3.x and is
 * removed in 1.0.0.
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
 * §5.6 — Rule row, as the lines it occupies. Each RuleType renders differently so the reviewer
 * can tell what failed at a glance. Missing per-type payloads (a `guard` without `condition`, a
 * `loop` without `loopKind`, etc.) violate the IR contract in ir-schema §8.2 and throw
 * `ProjectionInvariantError` so an upstream extractor bug does not surface as
 * `- guard:  (L5)` in a reviewer's PR.
 *
 * `switch` exhaustiveness is enforced by the trailing `never` branch — adding a new
 * `RuleType` to the schema will produce a compile error here instead of a silent
 * "plain `<type>` (L<line>)" fallback.
 *
 * An array rather than a string because a payload long enough to fence occupies four lines, and
 * every caller pushes into a `string[]` whose elements are joined with a newline: one element
 * holding several lines reads as one line to anything that counts or slices them. Callers spread
 * (`rows.push(...ruleRow(r))`). `payloadRow` explains the two shapes.
 *
 * The label is `rule.type` itself. Writing the word out per branch compiles just as well with a
 * typo in it, and the discriminant is already the word the row wants.
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
 * One rule row, in whichever of its two shapes the payload fits.
 *
 * `- guard: <code> (L5)` is the row §5.6 documents and the one nearly every rule takes.
 * It cannot hold a fenced block: the fence would open at column 0 in the middle of the
 * item, which CommonMark reads as the end of the list — the `(L5)` after it becomes a
 * paragraph of its own and the rules below it restart as a second list. And a fence is
 * exactly what a condition over `INLINE_CODE_MAX_LENGTH` asks for; a boolean guard that
 * long is routine, since ir-schema.md §8.2 truncates a payload only past 120 characters.
 *
 * So a payload that fences takes the second shape, with the line tag moved ahead of the
 * colon — the block has to be last — and the fence indented into the item:
 *
 * ````md
 * - guard (L3):
 *   ```
 *   user.role === 'admin' && flags.enabled && !session.expired && ctx.tenant === wantedTenant
 *   ```
 * ````
 *
 * (The outer fence there is four backticks on purpose: at three, the indented inner fence
 * closes it — up to three spaces of indentation still counts as a closing fence — and the rest
 * of this comment renders as body text wherever the docblock is shown.)
 *
 * An empty payload renders as `EMPTY_VALUE`, through `inlineCode` like every other value.
 * `Rule.condition` / `what` / `expr` carry a `maxLength` and no `minLength` in
 * `aburi.ir.v1`, so the empty string is a document this projection has to render rather than
 * an invariant it may throw on — unlike `dropReason`, whose `minLength: 1` is what lets
 * `requireDropReason` refuse it.
 */
function payloadRow(label: string, value: string, line: number): string[] {
  // The length is what reaches the second shape in practice: ir-schema.md §8.2 has the
  // extractor remove newlines from these three fields, so a multiline payload means a writer
  // that did not, and `fitsInline` sends it to the same block rather than into the row.
  if (fitsInline(value)) return [`- ${label}: ${inlineCode(value)} (L${line})`]
  return [`- ${label} (L${line}):`, ...fencedBlock(value, LIST_ITEM_INDENT).split("\n")]
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
