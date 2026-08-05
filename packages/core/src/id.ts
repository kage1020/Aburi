/**
 * Symbol and Component id construction.
 *
 * This module is the single place in the workspace that mints a branded `SymbolId` or
 * `ComponentId` (ir-schema.md §3.5). Every other package reaches one through the
 * constructors here or through the `isSymbolId` / `isComponentId` guards, so "is this string
 * a well-formed id?" has one implementation rather than one per call site — and an id that
 * reaches the IR has necessarily passed it.
 */
import type { ComponentId, LanguageId, SymbolId } from "@aburi/types"
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

/**
 * ASCII kebab-case, matching `aburi.ir.v1.json#/$defs/ComponentId`.
 *
 * A segment may start with a digit. Component ids are derived by kebab-casing a package or
 * directory name (component-detect.md §4.1), and `3d-force-graph` / `7zip-bin` are ordinary
 * npm package names — a letter-first rule would make the documented derivation partial for
 * no gain, since nothing distinguishes a Component id by its first character.
 */
const COMPONENT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

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
  const normalized = normalizeParts(parts)
  const violation = symbolIdViolation(normalized)
  if (violation !== null) {
    throw new CoreError(violation.message, { code: violation.code, value: violation.value })
  }
  return composeSymbolId(normalized)
}

/**
 * Non-throwing counterpart of `makeSymbolId`, for call sites that assemble a *candidate* id
 * and then test it against a set of known ids — resolvers guessing at a callee, and the diff
 * matcher predicting an id across a file rename. An id that cannot be built is a candidate
 * that cannot match any Symbol, which is the same outcome as building it and finding it
 * absent, so returning `null` keeps those call sites behaving as they did when they
 * concatenated the parts by hand.
 *
 * A refusal is therefore never silently lossy *provided* every id in the set went through
 * `makeSymbolId` too — which invariant #17 (ir-schema.md §14) is what guarantees, including
 * for a document read off disk.
 */
export function trySymbolId(parts: SymbolIdParts): SymbolId | null {
  const normalized = normalizeParts(parts)
  if (symbolIdViolation(normalized) !== null) return null
  return composeSymbolId(normalized)
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
 * Build a `LanguageId` — the token before the colon of a Symbol id, the element type of
 * `workspace.languages`, and what a language plugin declares as `languageId`.
 *
 * Same grammar and same reserved list the Symbol id constructor applies to its language
 * segment, so a plugin cannot declare one token and stamp another. Three vocabularies sit
 * close enough to be mistaken for this one — the plugin manifest name (`lang-typescript`),
 * the component detector's per-extension token (`tsx`, `js`), and the npm package id — and
 * the first of those was in fact assigned straight into `workspace.languages`, producing
 * documents the frozen IR schema rejects.
 */
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

/**
 * Narrow an arbitrary string to a `SymbolId`: does it satisfy everything `makeSymbolId`
 * would have enforced had it built the id?
 *
 * Answers by splitting the string back into its three parts and running the same check the
 * constructor runs, rather than by a whole-string regex. A regex tight enough to be
 * equivalent would have to re-encode the reserved-token list, the `..` rule and the
 * qualified-name grammar, and the two would drift the first time one of them changed. The
 * split is unambiguous because the parts are separated by the first `:` and the first `#`,
 * and neither the language token nor the file path may contain either character.
 *
 * A predicate that only tested the id's silhouette would be worse than none: `SliceId` is
 * assignable to `string`, so `isSymbolId(someSliceId)` compiles, and a loose predicate would
 * hand back a `SymbolId` for it — forging the exact namespace crossing the brand exists to
 * prevent.
 */
export function isSymbolId(value: string): value is SymbolId {
  const parts = splitSymbolId(value)
  return parts !== null && symbolIdViolation(parts) === null
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
  // NFC as well as separator normalization. Which Unicode spelling a path arrives in
  // depends on how the name was created — a decomposed `é` from an archive, an HFS+ volume
  // or a Finder rename survives on any platform — so the same source tree can hand back
  // two different strings for one file. This is the single point where a path enters the
  // process, so normalizing here keeps `symbol.source.file`, `components[].roots` and the
  // Symbol id built from that path spelled identically. Normalizing only inside the id
  // constructor would leave them disagreeing.
  const normalized = rawPath.replace(/\\/g, "/").normalize("NFC")
  const violation = posixWorkspaceRelativeViolation(normalized)
  if (violation !== null) {
    throw new CoreError(violation.message, { code: violation.code, value: violation.value })
  }
  return normalized
}

/**
 * Put every part into Unicode NFC, which is the form an id is defined to be in.
 *
 * This keeps the id held in memory and the id written to disk the same string:
 * `serializeCanonical` normalizes on write while the integrity sort check compares the
 * in-memory value, so an un-normalized id could satisfy that check and still land out of
 * order in the file.
 *
 * It runs before validation rather than after, so `symbolIdViolation` — which rejects a
 * non-NFC part — describes exactly the ids `isSymbolId` will accept. Normalization cannot
 * introduce a separator: the only characters whose NFC form is ASCII are U+037E, U+1FEF
 * and U+212A, mapping to `;`, a backtick and `K`.
 *
 * Only the file path can differ in practice. `posixWorkspaceRelativeViolation` imposes no
 * ASCII restriction, whereas the language and qualified-name grammars are ASCII-only and
 * so normalize to themselves; those two are covered anyway, so widening either grammar
 * does not quietly reopen this.
 */
function normalizeParts(parts: SymbolIdParts): SymbolIdParts {
  return {
    language: parts.language.normalize("NFC"),
    file: parts.file.normalize("NFC"),
    qualifiedName: parts.qualifiedName.normalize("NFC"),
  }
}

/**
 * Assemble the id from parts already known to be valid and normalized. Both public
 * constructors run the full check first and share this, so the format lives in one place.
 */
function composeSymbolId(parts: SymbolIdParts): SymbolId {
  return `${parts.language}:${parts.file}#${parts.qualifiedName}` as SymbolId
}

/**
 * Inverse of `composeSymbolId`: recover the three parts from an assembled id, or `null` when
 * the string has no `:` / `#` structure at all. Neither the language token nor the file path
 * may contain `:` or `#`, so the first occurrence of each is the separator — which is why
 * `posixWorkspaceRelativeViolation` rejects both characters in a path.
 */
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
function symbolIdViolation(parts: SymbolIdParts): IdViolation | null {
  return (
    languageIdViolation(parts.language) ??
    posixWorkspaceRelativeViolation(parts.file) ??
    qualifiedNameViolation(parts.qualifiedName) ??
    unnormalizedViolation(parts)
  )
}

/**
 * Reject a part that is not in Unicode NFC.
 *
 * `composeSymbolId` normalizes, so `makeSymbolId` cannot mint such an id — but `isSymbolId`
 * runs these same checks against a string it did not build, and that is what invariant #17
 * uses to decide whether a document read off disk holds well-formed ids. Without this the
 * predicate would accept an id the constructor can no longer produce, and `trySymbolId`'s
 * safety argument — which rests on every id in the set having gone through the constructor
 * — would not hold for a document Aburi did not write.
 */
function unnormalizedViolation(parts: SymbolIdParts): IdViolation | null {
  for (const [field, raw] of [
    ["language", parts.language],
    ["file", parts.file],
    ["qualified name", parts.qualifiedName],
  ] as const) {
    if (raw === raw.normalize("NFC")) continue
    return {
      code: "invalid-symbol-id",
      message: `Symbol id ${field} "${raw}" is not in Unicode NFC; ids are normalized at construction so the in-memory and written forms match`,
      value: raw,
    }
  }
  return null
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
  // `:` and `#` are the id's own separators, so a path holding either assembles into a
  // string whose first `:` / `#` fall in the wrong place: it still satisfies the schema
  // pattern, but splitting it back yields parts the producer never wrote. Checked last so a
  // Windows drive path still reports the more useful "is absolute".
  if (path.includes(":") || path.includes("#")) {
    return {
      code: "non-posix-path",
      message: `Symbol id file path "${path}" contains ":" or "#", the two Symbol id separators (ir-schema.md §3.1)`,
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
