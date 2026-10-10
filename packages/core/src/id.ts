import type { ComponentId, LanguageId, SymbolId } from "@aburi/types"
import { describeCodePoints, toNfc } from "./codepoints"
import { CoreError, type CoreErrorCode } from "./errors"

/** Sentinel qualified name reserved for the lone default export of a module. */
export const DEFAULT_EXPORT_QNAME = "<default>"

/** Lowercase-ASCII kebab-ish language id (e.g. "ts", "tsx", "py", "go", "rs"). */
const LANGUAGE_ID_PATTERN = /^[a-z][a-z0-9]*$/

export const RESERVED_LANGUAGE_IDS: ReadonlySet<string> = new Set(["slice"])

const QNAME_SEGMENT_PATTERN = /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u

const PRIVATE_NAME_PATTERN = /^#[$_\p{ID_Start}][$\p{ID_Continue}]*$/u

const ABSOLUTE_PATH_PATTERN = /^([/\\]|[A-Za-z]:)/

const COMPONENT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface SymbolIdParts {
  language: string
  file: string
  qualifiedName: string
}

/** The subset of `CoreErrorCode` a grammar check can produce. */
type GrammarViolationCode = Extract<
  CoreErrorCode,
  "anonymous-symbol-id-attempted" | "invalid-language-id" | "invalid-symbol-id" | "non-posix-path"
>

export interface GrammarViolation {
  code: GrammarViolationCode
  message: string
  value: string
}

export function makeSymbolId(parts: SymbolIdParts): SymbolId {
  const normalized = normalizeParts(parts)
  const violation = symbolIdViolation(normalized)
  if (violation !== null) {
    throw new CoreError(violation.message, { code: violation.code, value: violation.value })
  }
  return composeSymbolId(normalized)
}

export function trySymbolId(parts: SymbolIdParts): SymbolId | null {
  const normalized = normalizeParts(parts)
  if (symbolIdViolation(normalized) !== null) return null
  return composeSymbolId(normalized)
}

export function makeComponentId(raw: string): ComponentId {
  if (!COMPONENT_ID_PATTERN.test(raw)) {
    throw new CoreError(
      `Component id "${raw}" violates the ASCII kebab-case pattern required by ir-schema.md`,
      { code: "invalid-component-id", value: raw },
    )
  }
  return raw as ComponentId
}

export function makeLanguageId(raw: string): LanguageId {
  const violation = languageIdViolation(raw)
  if (violation !== null) {
    throw new CoreError(`Language id "${raw}": ${violation.message}`, {
      code: violation.code,
      value: raw,
    })
  }
  return raw as LanguageId
}

/** Narrowing counterpart to `makeLanguageId` for values arriving from outside the process. */
export function isLanguageId(value: string): value is LanguageId {
  return languageIdViolation(value) === null
}

export function isSymbolId(value: string): value is SymbolId {
  const parts = splitSymbolId(value)
  return parts !== null && symbolIdViolation(parts) === null
}

export function symbolIdFile(value: string): string | null {
  const parts = splitSymbolId(value)
  if (parts === null || symbolIdViolation(parts) !== null) return null
  return parts.file
}

/** Narrow an arbitrary string to a `ComponentId`. Counterpart of `isSymbolId`. */
export function isComponentId(value: string): value is ComponentId {
  return COMPONENT_ID_PATTERN.test(value)
}

export function makeMemberQname(
  ownerChain: readonly string[],
  member: string,
  kind: "instance" | "static",
): string {
  if (ownerChain.length === 0) {
    throw new CoreError(
      `member qualified name requires at least one owner segment (got "${member}")`,
      { code: "anonymous-symbol-id-attempted", value: member },
    )
  }
  for (const segment of ownerChain) assertQnameSegment(segment, segment)
  assertQnameSegment(member, member, { privateName: true })
  const separator = kind === "instance" ? "." : "::"
  return `${ownerChain.join(".")}${separator}${member}`
}

export function makeTopLevelQname(name: string): string {
  assertQnameSegment(name, name)
  return name
}

export function makeNestedQname(segments: readonly string[]): string {
  if (segments.length === 0) {
    throw new CoreError("nested qualified name requires at least one segment", {
      code: "anonymous-symbol-id-attempted",
      value: "",
    })
  }
  for (const segment of segments) assertQnameSegment(segment, segment)
  return segments.join(".")
}

/** Detect whether a qualified name is the reserved `<default>` sentinel. */
export function isDefaultExportQname(qname: string): boolean {
  return qname === DEFAULT_EXPORT_QNAME
}

export function toDocumentPath(rawPath: string): string {
  const normalized = toNfc(rawPath)
  const violation = posixWorkspaceRelativeViolation(normalized)
  if (violation !== null) {
    throw new CoreError(violation.message, { code: violation.code, value: violation.value })
  }
  return normalized
}

const SYMBOL_ID_SEPARATORS = [":", "#"] as const

/** Where a path holds a backslash, which a Document path has no spelling for. */
export interface BackslashSite {
  /** The first `/`-delimited segment whose own name holds one. */
  segment: string
  /**
   * `path` truncated to the end of that segment: the shortest prefix of it that already
   * cannot be named, and therefore exactly what a rename has to change. Every path under a
   * directory whose name holds a backslash shares one.
   */
  prefix: string
}

export function backslashSite(path: string): BackslashSite | null {
  const segments = path.split("/")
  for (const [index, segment] of segments.entries()) {
    if (segment.includes("\\")) {
      return { segment, prefix: segments.slice(0, index + 1).join("/") }
    }
  }
  return null
}

/** Where a path holds an id separator, and which ones. */
export interface SymbolIdSeparatorSite {
  /** The `/`-delimited segment that holds them — a directory name as readily as a filename. */
  segment: string
  /** The separators that segment holds, in id order. */
  separators: readonly string[]
}

export function symbolIdSeparatorSite(path: string): SymbolIdSeparatorSite | null {
  for (const segment of path.split("/")) {
    const separators = SYMBOL_ID_SEPARATORS.filter((separator) => segment.includes(separator))
    if (separators.length > 0) return { segment, separators }
  }
  return null
}

export function toPosixRelative(rawPath: string): string {
  const normalized = toNfc(rawPath)
  const violation = symbolIdPathViolation(normalized)
  if (violation !== null) {
    throw new CoreError(violation.message, { code: violation.code, value: violation.value })
  }
  return normalized
}

function normalizeParts(parts: SymbolIdParts): SymbolIdParts {
  return {
    language: toNfc(parts.language),
    file: toNfc(parts.file),
    qualifiedName: toNfc(parts.qualifiedName),
  }
}

function composeSymbolId(parts: SymbolIdParts): SymbolId {
  return `${parts.language}:${parts.file}#${parts.qualifiedName}` as SymbolId
}

function splitSymbolId(value: string): SymbolIdParts | null {
  const colon = value.indexOf(":")
  if (colon < 0) return null
  const hash = value.indexOf("#", colon + 1)
  if (hash < 0) return null
  return {
    language: value.slice(0, colon),
    file: value.slice(colon + 1, hash),
    qualifiedName: value.slice(hash + 1),
  }
}

/** Full validation of a candidate Symbol id, in the order the assertions used to run. */
function symbolIdViolation(parts: SymbolIdParts): GrammarViolation | null {
  return (
    languageIdViolation(parts.language) ??
    symbolIdPathViolation(parts.file) ??
    qualifiedNameViolation(parts.qualifiedName) ??
    unnormalizedViolation(parts)
  )
}

function unnormalizedViolation(parts: SymbolIdParts): GrammarViolation | null {
  for (const [field, raw] of [
    ["language", parts.language],
    ["file", parts.file],
    ["qualified name", parts.qualifiedName],
  ] as const) {
    if (raw === toNfc(raw)) continue
    return {
      code: "invalid-symbol-id",
      message: `Symbol id ${field} ${describeCodePoints(raw)} is not in Unicode NFC; write it as ${describeCodePoints(toNfc(raw))}`,
      value: raw,
    }
  }
  return null
}

function languageIdViolation(language: string): GrammarViolation | null {
  if (!LANGUAGE_ID_PATTERN.test(language)) {
    return {
      code: "invalid-language-id",
      message: `Symbol id language "${language}" violates the lowercase-ASCII identifier pattern`,
      value: language,
    }
  }
  if (RESERVED_LANGUAGE_IDS.has(language)) {
    return {
      code: "invalid-language-id",
      message:
        `Symbol id language "${language}" is reserved and cannot be claimed by a language ` +
        `plugin; an id in this namespace would be indistinguishable from a Slice id`,
      value: language,
    }
  }
  return null
}

/** How a path site is named in its rejection message. */
const PATH_SUBJECT = "path"
const SYMBOL_ID_PATH_SUBJECT = "Symbol id file path"

export function posixWorkspaceRelativeViolation(
  path: string,
  subject: string = PATH_SUBJECT,
): GrammarViolation | null {
  if (path.length === 0) {
    return { code: "non-posix-path", message: `${subject} is empty`, value: path }
  }
  if (backslashSite(path) !== null) {
    return {
      code: "non-posix-path",
      message: `${subject} "${path}" contains a backslash; "/" is the only separator a Document path has, so a native path must be converted before it reaches this rule, and a name holding one cannot be written here at all`,
      value: path,
    }
  }
  if (ABSOLUTE_PATH_PATTERN.test(path)) {
    return {
      code: "non-posix-path",
      message: `${subject} "${path}" is absolute; only workspace-relative paths are allowed`,
      value: path,
    }
  }
  const segments = path.split("/")
  if (segments.some((s) => s === "..")) {
    return {
      code: "non-posix-path",
      message: `${subject} "${path}" leaves the workspace through a ".." segment, so it names something outside what the Document describes`,
      value: path,
    }
  }
  if (path !== "." && segments.some((s) => s === ".")) {
    return {
      code: "non-posix-path",
      message: `${subject} "${path}" contains a "." segment; a path has one spelling, and "${segments.filter((s) => s !== ".").join("/")}" is it`,
      value: path,
    }
  }
  return null
}

function symbolIdPathViolation(path: string): GrammarViolation | null {
  const violation = posixWorkspaceRelativeViolation(path, SYMBOL_ID_PATH_SUBJECT)
  if (violation !== null) return violation
  if (path === ".") {
    return {
      code: "non-posix-path",
      message: `${SYMBOL_ID_PATH_SUBJECT} is "."; that names the workspace root, and a directory holds no Symbol`,
      value: path,
    }
  }
  if (symbolIdSeparatorSite(path) !== null) {
    return {
      code: "non-posix-path",
      message: `${SYMBOL_ID_PATH_SUBJECT} "${path}" contains ":" or "#", the two Symbol id separators (ir-schema.md)`,
      value: path,
    }
  }
  return null
}

export function isQualifiedName(value: string): boolean {
  return qualifiedNameViolation(value) === null
}

export function isQnameSegment(value: string, options: SegmentOptions = {}): boolean {
  return (
    QNAME_SEGMENT_PATTERN.test(value) ||
    (options.privateName === true && PRIVATE_NAME_PATTERN.test(value))
  )
}

export interface SegmentOptions {
  privateName?: boolean
}

function qualifiedNameViolation(qname: string): GrammarViolation | null {
  if (qname.length === 0) {
    return {
      code: "anonymous-symbol-id-attempted",
      message: "qualified name is empty",
      value: qname,
    }
  }
  if (qname === DEFAULT_EXPORT_QNAME) return null
  if (containsAnonymousMarker(qname)) {
    return {
      code: "anonymous-symbol-id-attempted",
      message: `qualified name "${qname}" looks anonymous (position-dependent markers like <anon@L42> are forbidden); attach the construct to its parent Symbol instead`,
      value: qname,
    }
  }
  for (const [index, segment] of splitQnameSegments(qname).entries()) {
    if (segment.length === 0) {
      return {
        code: "anonymous-symbol-id-attempted",
        message: `qualified name "${qname}" has an empty segment; "." and "::" join two named constructs, so neither may sit at an end or beside another`,
        value: qname,
      }
    }
    if (!isQnameSegment(segment, { privateName: index > 0 })) {
      return {
        code: "anonymous-symbol-id-attempted",
        message: `qualified name "${qname}" contains the non-identifier segment "${segment}"`,
        value: qname,
      }
    }
  }
  return null
}

function splitQnameSegments(qname: string): string[] {
  return qname.split(/::|\./)
}

function assertQnameSegment(
  segment: string,
  originalQname: string,
  options: SegmentOptions = {},
): void {
  if (!isQnameSegment(segment, options)) {
    throw new CoreError(
      `qualified name "${originalQname}" contains the non-identifier segment "${segment}"`,
      { code: "anonymous-symbol-id-attempted", value: originalQname },
    )
  }
}

function containsAnonymousMarker(qname: string): boolean {
  if (qname.startsWith("<") && qname !== DEFAULT_EXPORT_QNAME) return true
  return /<anon|@L\d+/.test(qname)
}
