/**
 * Symbol and Component id construction.
 *
 * This module is the single place in the workspace that mints a branded `SymbolId` or
 * `ComponentId` (ir-schema.md §3.5). Every other package reaches one through the
 * constructors here or through the `isSymbolId` / `isComponentId` guards, so "is this string
 * a well-formed id?" has one implementation rather than one per call site — and an id that
 * reaches the IR has necessarily passed it.
 */
import type { ComponentId, SymbolId } from "@aburi/types"
import { CoreError, type CoreErrorCode } from "./errors"

/** Sentinel qualified name reserved for the lone default export of a module. */
export const DEFAULT_EXPORT_QNAME = "<default>"

/** Lowercase-ASCII kebab-ish language id (e.g. "ts", "tsx", "py", "go", "rs"). */
const LANGUAGE_ID_PATTERN = /^[a-z][a-z0-9]*$/

/**
 * Language tokens no plugin may claim, because a Symbol id built from them would collide
 * with an id minted in a different namespace. Today that is `slice`: Slice ids are
 * `"slice:" + <anchor Symbol id>` (slice-view.md §7.1), so a `slice` language plugin would
 * produce Symbol ids indistinguishable from Slice ids, and deriving a Slice id from one of
 * them would yield `slice:slice:...`. The brand on `SymbolId` / `SliceId` keeps the two
 * apart inside typed code; this keeps them apart on the wire.
 *
 * Exported so `checkIRIntegrity` can enforce the same list on a document it did not build
 * (ir-schema.md §14 invariant #16) without a second copy of it.
 */
export const RESERVED_LANGUAGE_IDS: ReadonlySet<string> = new Set(["slice"])

/** Identifier-like segment that may appear in a qualified name (no separators, no spaces). */
const QNAME_SEGMENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Path that contains the workspace-relative POSIX shape expected by Symbol.id. */
const ABSOLUTE_PATH_PATTERN = /^([/\\]|[A-Za-z]:[\\/])/

/** ASCII kebab-case, matching `aburi.ir.v1.json#/$defs/ComponentId`. */
const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** Whole Symbol id shape, matching `aburi.ir.v1.json#/$defs/SymbolId`. */
const SYMBOL_ID_PATTERN = /^[a-z][a-z0-9]*:[^#\\]+#[^\\]+$/

export interface SymbolIdParts {
  language: string
  file: string
  qualifiedName: string
}

/** A reason a candidate Symbol id was rejected, in the shape `CoreError` wants. */
interface IdViolation {
  code: CoreErrorCode
  message: string
  value: string
}

/**
 * Build a Symbol id from its three deterministic components. Refuses anything that would
 * make the id position-dependent (anonymous qualified names, backslash paths, absolute
 * paths, ascending `..` paths), so position-dependent ids cannot leak into the IR.
 *
 * Use this wherever a failed id is a bug. Where a candidate id is speculative — a resolver
 * guessing at a callee that may not exist — use `trySymbolId` instead, which reports the
 * same rejections as `null`.
 */
export function makeSymbolId(parts: SymbolIdParts): SymbolId {
  const violation = symbolIdViolation(parts)
  if (violation !== null) {
    throw new CoreError(violation.message, { code: violation.code, value: violation.value })
  }
  return composeSymbolId(parts)
}

/**
 * Non-throwing counterpart of `makeSymbolId`, for call sites that assemble a *candidate* id
 * and then test it for existence — the call-graph resolver and the LSP enrichment pass both
 * do this. An id they cannot build is a candidate that cannot match any Symbol, which is the
 * same outcome as building it and finding it absent from the known-id set, so returning
 * `null` keeps the resolver's behaviour identical to concatenating the parts by hand.
 */
export function trySymbolId(parts: SymbolIdParts): SymbolId | null {
  if (symbolIdViolation(parts) !== null) return null
  return composeSymbolId(parts)
}

/**
 * Build a Component id. The kebab-case shape is what `components[].id` is validated against
 * on the wire, and what tells a Component endpoint apart from a Symbol endpoint in
 * `dependencies[]` (ir-schema.md §11).
 */
export function makeComponentId(raw: string): ComponentId {
  if (!COMPONENT_ID_PATTERN.test(raw)) {
    throw new CoreError(
      `Component id "${raw}" violates the ASCII kebab-case pattern required by ir-schema.md §4`,
      { code: "invalid-component-id", value: raw },
    )
  }
  return raw as ComponentId
}

/**
 * Narrow an arbitrary string to a `SymbolId`. Used on `dependencies[].from` / `.to`, which
 * hold either id kind and are told apart by shape alone.
 */
export function isSymbolId(value: string): value is SymbolId {
  return SYMBOL_ID_PATTERN.test(value)
}

/** Narrow an arbitrary string to a `ComponentId`. Counterpart of `isSymbolId`. */
export function isComponentId(value: string): value is ComponentId {
  return COMPONENT_ID_PATTERN.test(value)
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
  const violation = posixWorkspaceRelativeViolation(normalized)
  if (violation !== null) {
    throw new CoreError(violation.message, { code: violation.code, value: violation.value })
  }
  return normalized
}

/**
 * The only unchecked construction of a branded id in the workspace. Both public
 * constructors run the full check first and share this so the format lives in one place.
 */
function composeSymbolId(parts: SymbolIdParts): SymbolId {
  return `${parts.language}:${parts.file}#${parts.qualifiedName}` as SymbolId
}

/** Full validation of a candidate Symbol id, in the order the assertions used to run. */
function symbolIdViolation(parts: SymbolIdParts): IdViolation | null {
  return (
    languageIdViolation(parts.language) ??
    posixWorkspaceRelativeViolation(parts.file) ??
    qualifiedNameViolation(parts.qualifiedName)
  )
}

function languageIdViolation(language: string): IdViolation | null {
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

function posixWorkspaceRelativeViolation(path: string): IdViolation | null {
  if (path.length === 0) {
    return { code: "non-posix-path", message: "Symbol id file path is empty", value: path }
  }
  if (path.includes("\\")) {
    return {
      code: "non-posix-path",
      message: `Symbol id file path "${path}" contains a backslash; pass it through toPosixRelative() first`,
      value: path,
    }
  }
  if (ABSOLUTE_PATH_PATTERN.test(path)) {
    return {
      code: "non-posix-path",
      message: `Symbol id file path "${path}" is absolute; rebase it onto the workspace root`,
      value: path,
    }
  }
  if (path.split("/").some((s) => s === "..")) {
    return {
      code: "non-posix-path",
      message: `Symbol id file path "${path}" escapes the workspace via "..", which would leak the host layout into the IR`,
      value: path,
    }
  }
  return null
}

function qualifiedNameViolation(qname: string): IdViolation | null {
  if (qname.length === 0) {
    return {
      code: "anonymous-symbol-id-attempted",
      message: "Symbol id qualified name is empty",
      value: qname,
    }
  }
  if (qname === DEFAULT_EXPORT_QNAME) return null
  if (containsAnonymousMarker(qname)) {
    return {
      code: "anonymous-symbol-id-attempted",
      message: `Symbol id qualified name "${qname}" looks anonymous (position-dependent markers like <anon@L42> are forbidden); attach the construct to its parent Symbol instead`,
      value: qname,
    }
  }
  for (const segment of splitQnameSegments(qname)) {
    if (!QNAME_SEGMENT_PATTERN.test(segment)) {
      return {
        code: "anonymous-symbol-id-attempted",
        message: `Symbol id qualified name "${qname}" contains the non-identifier segment "${segment}"`,
        value: qname,
      }
    }
  }
  return null
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
