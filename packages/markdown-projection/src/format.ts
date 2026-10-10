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

export function confidenceBadge(value: Confidence): string {
  if (value === "high") return ""
  return ` ⚠ ${value}`
}

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

const LINE_ENDING = /\r\n|\r|\n/

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

export function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item)
}

export const EMPTY_VALUE = "(empty)"

export function inlineCode(value: string): string {
  const collapsed = value.replace(new RegExp(`\\s*(?:${LINE_ENDING.source})\\s*`, "g"), " ")
  if (collapsed.length === 0) return EMPTY_VALUE
  const fence = "`".repeat(longestBacktickRun(collapsed) + 1)
  const edge = `${collapsed.at(0)}${collapsed.at(-1)}`
  const pad = edge.includes("`") || edge.includes(" ") ? " " : ""
  return `${fence}${pad}${collapsed}${pad}${fence}`
}

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
 * markdown-projection.md §5.5 — `(name: type) → output`, each input as `formatInput` spells
 * it (`a?: string`, `...ids: string[]`), + optional `throws A, B` + `⚡async` /
 * `*generator*` / `<T,U>` badges; multiple outputs are `|`-separated. `null` when there is
 * no signature, so the section-omit logic can branch on presence.
 */
export function signatureLine(signature: Signature | null | undefined): string | null {
  if (signature === null || signature === undefined) return null
  const inputs = signature.inputs.map(formatInput).join(", ")
  const outputs = signature.outputs.length > 0 ? signature.outputs.join(" | ") : "void"
  const throwsPart = signature.throws.length > 0 ? ` throws ${signature.throws.join(", ")}` : ""
  const asyncBadge = signature.async ? " ⚡async" : ""
  const genBadge = signature.generator ? " *generator*" : ""
  const typeParams =
    signature.typeParameters.length > 0 ? `<${signature.typeParameters.join(",")}>` : ""
  return `${inlineCode(`${typeParams}(${inputs}) → ${outputs}`)}${throwsPart}${asyncBadge}${genBadge}`
}

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

function payloadRow(label: string, value: string, line: number): string[] {
  if (fitsInline(value)) return [`- ${label}: ${inlineCode(value)} (L${line})`]
  return [`- ${label} (L${line}):`, ...fencedBlock(value, LIST_ITEM_INDENT).split("\n")]
}

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

export function effectRow(eff: Effect): string {
  if (eff.propagated === true) {
    return `- ${eff.id}: ${inlineCode(eff.target)} ${propagatedFromSuffix(eff.derivedFrom ?? [])} [${eff.plugin}]${confidenceBadge(eff.confidence)}`
  }
  return `- ${eff.id}: ${inlineCode(eff.target)} (L${eff.line}) [${eff.plugin}]${confidenceBadge(eff.confidence)}`
}

/** Shared rendering for the direct sources required on every propagated effect. */
export function propagatedFromSuffix(derivedFrom: readonly string[]): string {
  if (derivedFrom.length === 0) {
    throw new ProjectionInvariantError("derivedFrom", "propagated Effect")
  }
  return `[propagated from ${derivedFrom.join(", ")}]`
}

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

export function callRow(call: Call): string {
  return `- ${inlineCode(call.target)} (L${call.line})`
}

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
  return `#### ${symbolTitle(symbol)}`
}

export function symbolTitle(symbol: IRSymbol): string {
  return `${inlineCode(symbol.name)} *(${symbol.kind})*${confidenceBadge(symbol.confidence)}`
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

const SYMBOL_ID_PATTERN = /^[a-z][a-z0-9]*:[^#]+#.+$/

/** Whether an endpoint has the Symbol id silhouette rather than the Component id one. */
export function isSymbolIdEndpoint(endpoint: DependencyEndpoint): boolean {
  return SYMBOL_ID_PATTERN.test(endpoint)
}

/** Whether either end of a Dependency is a Symbol, which routes it to the symbol-level sections. */
export function isSymbolEdge(dependency: Dependency): boolean {
  return isSymbolIdEndpoint(dependency.from) || isSymbolIdEndpoint(dependency.to)
}

/**
 * One `Signature.inputs` entry as TypeScript writes it — deliberately, whichever language the
 * IR came from, so a Python `*args` prints as `...args` too. The `rest` and `optional` fields
 * (ir-schema.md §7) go where TypeScript puts them, `...ids: string[]` and `a?: string`, and a
 * defaulted parameter prints as the optional one it is to a caller, `limit?`. An untyped
 * parameter prints its name alone, as it is written: an unannotated `(x)` and LP11a's
 * parenthesis-free `x => …` both carry `type: ""`.
 */
export function formatInput(input: {
  name: string
  type: string
  optional?: boolean | undefined
  rest?: boolean | undefined
}): string {
  const head = `${input.rest === true ? "..." : ""}${input.name}${input.optional === true ? "?" : ""}`
  return input.type === "" ? head : `${head}: ${input.type}`
}
