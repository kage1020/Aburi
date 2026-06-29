import { CoreError } from "./errors"

/** Sentinel qualified name reserved for the lone default export of a module. */
export const DEFAULT_EXPORT_QNAME = "<default>"

/** Lowercase-ASCII kebab-ish language id (e.g. "ts", "tsx", "py", "go", "rs"). */
const LANGUAGE_ID_PATTERN = /^[a-z][a-z0-9]*$/

/** Identifier-like segment that may appear in a qualified name (no separators, no spaces). */
const QNAME_SEGMENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Path that contains the workspace-relative POSIX shape expected by Symbol.id. */
const ABSOLUTE_PATH_PATTERN = /^([/\\]|[A-Za-z]:[\\/])/

/**
 * Build a Symbol id from its three deterministic components. Refuses anything that would
 * make the id position-dependent (anonymous qualified names, backslash paths, absolute
 * paths, ascending `..` paths), so position-dependent ids cannot leak into the IR.
 */
export function makeSymbolId(parts: {
  language: string
  file: string
  qualifiedName: string
}): string {
  assertLanguageId(parts.language)
  const file = assertPosixWorkspaceRelative(parts.file)
  assertQualifiedName(parts.qualifiedName)
  return `${parts.language}:${file}#${parts.qualifiedName}`
}

/**
 * Build the qualified name of a method or static member. `kind` decides the separator so
 * the IR stays consistent with how downstream tools render the receiver (instance methods
 * use ".", static members use "::").
 */
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
  assertQnameSegment(member, member)
  const separator = kind === "instance" ? "." : "::"
  return `${ownerChain.join(".")}${separator}${member}`
}

/**
 * Build a qualified name for a top-level construct (function, const, class, interface,
 * type alias). Variable-assigned function expressions reach this path via their binding
 * name — the call site is responsible for unwrapping the AST to find that name.
 */
export function makeTopLevelQname(name: string): string {
  assertQnameSegment(name, name)
  return name
}

/**
 * Build a qualified name for a nested namespace / module path
 * (e.g. `Billing.Invoice.create`). Each segment must be identifier-like.
 */
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

/**
 * Normalize a filesystem path into the POSIX, workspace-relative form Symbol.id requires.
 * Windows backslashes are rewritten; absolute paths and `..` ascents throw because they
 * are not valid Symbol.id inputs even after normalization (they would expose the host
 * filesystem layout in the IR).
 */
export function toPosixRelative(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/")
  return assertPosixWorkspaceRelative(normalized)
}

function assertLanguageId(language: string): void {
  if (!LANGUAGE_ID_PATTERN.test(language)) {
    throw new CoreError(
      `Symbol id language "${language}" violates the lowercase-ASCII identifier pattern`,
      { code: "invalid-language-id", value: language },
    )
  }
}

function assertPosixWorkspaceRelative(path: string): string {
  if (path.length === 0) {
    throw new CoreError("Symbol id file path is empty", {
      code: "non-posix-path",
      value: path,
    })
  }
  if (path.includes("\\")) {
    throw new CoreError(
      `Symbol id file path "${path}" contains a backslash; pass it through toPosixRelative() first`,
      { code: "non-posix-path", value: path },
    )
  }
  if (ABSOLUTE_PATH_PATTERN.test(path)) {
    throw new CoreError(
      `Symbol id file path "${path}" is absolute; rebase it onto the workspace root`,
      { code: "non-posix-path", value: path },
    )
  }
  const segments = path.split("/")
  if (segments.some((s) => s === "..")) {
    throw new CoreError(
      `Symbol id file path "${path}" escapes the workspace via "..", which would leak the host layout into the IR`,
      { code: "non-posix-path", value: path },
    )
  }
  return path
}

function assertQualifiedName(qname: string): void {
  if (qname.length === 0) {
    throw new CoreError("Symbol id qualified name is empty", {
      code: "anonymous-symbol-id-attempted",
      value: qname,
    })
  }
  if (qname === DEFAULT_EXPORT_QNAME) return
  if (containsAnonymousMarker(qname)) {
    throw new CoreError(
      `Symbol id qualified name "${qname}" looks anonymous (position-dependent markers like <anon@L42> are forbidden); attach the construct to its parent Symbol instead`,
      { code: "anonymous-symbol-id-attempted", value: qname },
    )
  }
  for (const segment of splitQnameSegments(qname)) {
    assertQnameSegment(segment, qname)
  }
}

/**
 * Split a fully-built qname back into the segments that must each pass the identifier
 * pattern. Both the instance separator (".") and the static separator ("::") split here.
 */
function splitQnameSegments(qname: string): string[] {
  return qname.split(/::|\./).filter((s) => s.length > 0)
}

function assertQnameSegment(segment: string, originalQname: string): void {
  if (!QNAME_SEGMENT_PATTERN.test(segment)) {
    throw new CoreError(
      `Symbol id qualified name "${originalQname}" contains the non-identifier segment "${segment}"`,
      { code: "anonymous-symbol-id-attempted", value: originalQname },
    )
  }
}

function containsAnonymousMarker(qname: string): boolean {
  if (qname.startsWith("<") && qname !== DEFAULT_EXPORT_QNAME) return true
  return /<anon|@L\d+/.test(qname)
}
