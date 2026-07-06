import type {
  Call,
  Confidence,
  Decorator,
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
  return `\`${path}\``
}

/**
 * §3.4 — inline vs. fenced choice. Anything ≤ `INLINE_CODE_MAX_LENGTH` and single-line
 * uses backticks; multiline strings ALWAYS render as fenced blocks so the newline
 * survives GitHub's Markdown pass without being folded into a single line.
 */
export function codeFragment(source: string, options: { forceFence?: boolean } = {}): string {
  const multiline = source.includes("\n")
  const forceFence = options.forceFence ?? false
  if (!forceFence && !multiline && source.length <= INLINE_CODE_MAX_LENGTH) {
    return `\`${source}\``
  }
  return `\n\`\`\`\n${source}\n\`\`\`\n`
}

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
  return decorators.map((d) => `\`@${d.raw}\``).join(" ")
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
  return `\`${typeParams}(${inputs}) → ${outputs}\`${throwsPart}${asyncBadge}${genBadge}`
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
 */
export function ruleRow(rule: Rule): string {
  const lineTag = `(L${rule.line})`
  switch (rule.type) {
    case "guard":
      return `- guard: ${inlineOrFence(requireField(rule, "condition"))} ${lineTag}`
    case "throw":
      return `- throw: ${inlineOrFence(requireField(rule, "what"))} ${lineTag}`
    case "return":
      return `- return: ${inlineOrFence(requireField(rule, "expr"))} ${lineTag}`
    case "loop":
      return `- loop (\`${requireField(rule, "loopKind")}\`) ${lineTag}`
    case "try":
      return `- try ${lineTag}`
    case "switch":
      return `- switch: ${inlineOrFence(requireField(rule, "condition"))} ${lineTag}`
    case "match":
      return `- match: ${inlineOrFence(requireField(rule, "condition"))} ${lineTag}`
    default:
      return assertNeverRule(rule)
  }
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

function inlineOrFence(text: string): string {
  if (text.length === 0) return "``"
  return codeFragment(text)
}

/**
 * §5.7 — Effect row. Format: `- <id>: \`<target>\` (L<line>) [<plugin>]<confidence-badge>`.
 * Extension effects (`x-<plugin>:<name>`) use the same shape — no special-casing needed
 * because id/target/plugin/confidence are all schema-mandatory.
 */
export function effectRow(eff: Effect): string {
  return `- ${eff.id}: \`${eff.target}\` (L${eff.line}) [${eff.plugin}]${confidenceBadge(eff.confidence)}`
}

/**
 * §5.8 — Call row. The row shape is deliberately identical whether or not `resolved` is
 * populated; v0.1 does not render the `resolved` Symbol id yet because the anchor scheme
 * for cross-Symbol links inside a single Markdown file is not finalised. Emitting the
 * resolved id here now would create PR churn when that scheme lands.
 */
export function callRow(callObj: Call): string {
  return `- \`${callObj.target}\` (L${callObj.line})`
}

/**
 * §5.9 — Fingerprint one-liner. Rendered inside `<sub>` so it does not compete for
 * attention. `null` returned for dropped Symbols (all-zero fingerprint) so §5.3 can omit
 * the row instead of emitting `<sub>api=\`000...\` ...\`</sub>` noise.
 */
export function fingerprintLine(fp: Fingerprint): string | null {
  if (isZeroFingerprint(fp)) return null
  return `<sub>api=\`${fp.api}\` logic=\`${fp.logic}\` syntax=\`${fp.syntax}\`</sub>`
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
  return `#### \`${symbol.name}\` *(${symbol.kind})*`
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
