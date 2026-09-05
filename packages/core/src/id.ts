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
import { describeCodePoints } from "./codepoints"
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

/**
 * Identifier-like segment that may appear in a qualified name (no separators, no spaces).
 *
 * ECMAScript's IdentifierName, less the `\u` escape forms no source has to use: a start
 * character is `ID_Start`, `$` or `_`, and a part character is `ID_Continue` or `$`.
 *
 * Only `$` and `_` are spelled out, and each for its own measured reason. `$` is in neither
 * property, so it is named in both classes. `_` is in `ID_Continue` and not in `ID_Start`, so
 * it is named in the first only. ZWNJ and ZWJ — which Persian and Arabic-script identifiers
 * use to control ligature shaping, and which ECMAScript names separately — are already in
 * `ID_Continue` here, so naming them again would say nothing.
 *
 * "Here" is load-bearing: `\p{ID_Continue}` resolves against the engine's Unicode tables, and
 * this was measured on the Node version the workspace pins (`engines.node >= 24`, which is
 * what CI runs). Lowering that floor is the change that would put ZWNJ and ZWJ back outside
 * the escape, so it is the change that would have to name them again.
 *
 * The ASCII-only grammar this replaces refused names `schema/aburi.ir.v1.json#/$defs/SymbolId`
 * already accepts — its pattern is `^[a-z][a-z0-9]*:[^#\\]+#[^\\]+$` — so a Japanese or
 * accented declaration threw here and cost its whole file at the per-file boundary. Widening
 * closes a gap between the two rather than opening one, and `lang-plugin.md` §3.2 says a qname
 * the grammar cannot express is a reason to widen the grammar rather than to work around it.
 *
 * What it still refuses is what is not a name at all: a destructuring pattern's text, a
 * computed member's brackets. Those are the plugin's to stop sending, not this pattern's to
 * accommodate.
 */
const QNAME_SEGMENT_PATTERN = /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u

/**
 * Prefixes that make a path absolute rather than workspace-relative. The Windows drive
 * letter needs no following separator: `C:a.ts` is drive-relative, resolves against a
 * per-drive working directory the IR does not record, and so is no more portable than
 * `C:/a.ts`.
 */
const ABSOLUTE_PATH_PATTERN = /^([/\\]|[A-Za-z]:)/

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

/** The subset of `CoreErrorCode` a grammar check can produce. */
type GrammarViolationCode = Extract<
  CoreErrorCode,
  "anonymous-symbol-id-attempted" | "invalid-language-id" | "invalid-symbol-id" | "non-posix-path"
>

/**
 * A reason a candidate id, qualified name or path was rejected, in the shape `CoreError`
 * wants. `message` already names its subject, so a caller neither builds nor edits it.
 */
export interface GrammarViolation {
  code: GrammarViolationCode
  message: string
  value: string
}

/**
 * Build a Symbol id from its three deterministic components.
 *
 * Refuses everything that would make the id position-dependent or ambiguous: anonymous and
 * empty-segment qualified names, backslash and absolute paths, `..` ascents, non-canonical
 * `.` segments, and the id's own `:` / `#` separators inside the path.
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

/**
 * The path segment of a Symbol id, or `null` when `value` is not a well-formed one.
 *
 * Answers "which file does this id claim its Symbol was declared in?" — a claim rather than a
 * fact. `symbols[].source.file` is where the document says the Symbol is, and the two come
 * apart for a re-export or a generated file, so a caller holding the Symbol reads `source.file`
 * instead. This is for the caller that has only the id, because the Symbol it names is missing.
 *
 * Runs the full grammar rather than merely splitting on the first `:` and `#`, so a string that
 * has only the silhouette of an id cannot hand back a path a caller would then make a statement
 * about.
 */
export function symbolIdFile(value: string): string | null {
  const parts = splitSymbolId(value)
  if (parts === null || symbolIdViolation(parts) !== null) return null
  return parts.file
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
 * Validate a path that is already POSIX-separated, and normalize it to NFC. This is the file
 * walk's entry point (ir-schema.md §1.2): what it returns becomes a `symbols[].source.file`, or
 * a `stats.skippedFiles[].path` for a file the walk gave up on.
 *
 * It does not convert separators, and a backslash reaching it is refused rather than rewritten.
 * Whether one is a separator is not decidable from the string, so the conversion belongs to the
 * caller that knows it holds a native path — see `normalizeToNfc` for what that cost while it
 * happened here.
 *
 * The shared path rule only. It does **not** answer whether a Symbol from that file could be
 * given an id: `:` and `#` are legal in a POSIX filename and legal in every path the Document
 * records, and are refused by the id grammar alone. Discovery asks that separately, with
 * `symbolIdSeparatorSite`, and records the answer instead of throwing it; `makeSymbolId` enforces
 * it again where the id is actually minted.
 *
 * The split exists because the two answers call for different responses. A path that is not
 * workspace-relative at all is a caller handing over something from outside what the Document
 * describes, and there is nothing to record. A path that merely cannot host an id is one file
 * to skip, and the skip entry names it using exactly this rule.
 *
 * Roots take a third entry point — `toRelativePosix` in `workspace.ts` — which normalizes to NFC
 * as this does and validates nothing, because a root may legitimately be `.` or ascend out of
 * the workspace and `mergeManager` is what drops those. It is also the one that *does* convert
 * separators, guarded on the platform's own, which is the arrangement this function's caller is
 * expected to copy.
 */
export function toDocumentPath(rawPath: string): string {
  const normalized = normalizeToNfc(rawPath)
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

/**
 * Where this path first holds a backslash, or `null` when it holds none.
 *
 * The character has no spelling in a Document path: `/` is the only separator one has, so a
 * name holding a backslash cannot be written down without a reader taking it for a segment
 * boundary. That makes it unlike `:` and `#`, which the id grammar refuses while the shared
 * rule admits them — a file those disqualify is still recordable by path, and a file this
 * disqualifies is not.
 *
 * Per segment for the same reason `symbolIdSeparatorSite` is: a backslash in a directory name
 * disqualifies every file beneath it, and each of those filenames is innocent. `prefix` is
 * what a report names, because the bare segment says what to rename but not where it is, and
 * two directories may share a name.
 *
 * `posixWorkspaceRelativeViolation` reads it as the predicate and discovery reads the prefix,
 * so a file discovery reports and a path the rule refuses are one set by construction.
 */
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

/**
 * The first segment of this path that holds an id separator, or `null` when none does.
 *
 * Per segment rather than per path, because the two answers are read by different callers and
 * only one of them is a predicate. A reporter that knew only "this path holds a `#`" blames the
 * file it is describing, and for `src/v#1/util.ts` that is a file whose name is innocent and a
 * rename that fixes nothing — the offending name is the directory's, and every file under it
 * carries the same cause.
 *
 * A separator can only ever sit inside a segment, `/` being what separates them, so a non-`null`
 * answer here and "the path holds one" are the same fact. `symbolIdPathViolation` reads it as
 * the predicate; discovery reads the segment.
 *
 * Non-throwing, and beside the grammar that enforces it so the two cannot drift — the same
 * arrangement `symbolIdFile` has. Discovery needs the answer without an exception: a file whose
 * path cannot host an id is one file to record, not the end of the walk, and the path itself is
 * still recordable because `stats.skippedFiles[].path` is held to the shared rule.
 *
 * `null` means the path holds no separator. It does not mean the path can host an id — a bare
 * `"."` holds none and is refused by `symbolIdPathViolation` all the same, because a directory
 * declares no Symbol.
 */
export function symbolIdSeparatorSite(path: string): SymbolIdSeparatorSite | null {
  for (const segment of path.split("/")) {
    const separators = SYMBOL_ID_SEPARATORS.filter((separator) => segment.includes(separator))
    if (separators.length > 0) return { segment, separators }
  }
  return null
}

/**
 * NFC, and nothing else: `toDocumentPath` above and `toPosixRelative` below share it, so the id
 * built from a path is spelled by the same string the Document records it as.
 *
 * It used to rewrite `\` into `/` first, on the theory that a caller might be holding a native
 * path. That cost the shared rule its backslash clause — the check ran on a string the character
 * had already been spent in — and silently renamed any file whose name legitimately held one.
 * Converting a native path is the caller's job because only the caller knows it has one;
 * `toRelativePosix` in `workspace.ts` shows the shape, rewriting on the platform separator,
 * which is a separator exactly where a filename cannot hold one.
 *
 * Shared by the two rather than one composed out of the other, so each applies its own rule and
 * reports it with its own subject. Layered, a path that breaks the shared rule
 * would be described by whichever function ran first, and a caller assembling a Symbol id would
 * be told about a "path".
 */
function normalizeToNfc(rawPath: string): string {
  return rawPath.normalize("NFC")
}

/**
 * Validate a path that is already POSIX-separated against the form `Symbol.id` requires, and
 * normalize it to NFC. Like `toDocumentPath`, it converts no separators.
 *
 * The shared path rule plus the id rule, where `toDocumentPath` applies the shared rule alone:
 * what this returns can be the file segment of a Symbol id, where what that returns can only be
 * a path the Document records.
 *
 * Nothing in this workspace calls it. The file walk takes `toDocumentPath` and records what
 * cannot host an id rather than refusing it, and `makeSymbolId` runs the same rule where the id
 * is minted — so this is for a caller outside the core that wants the refusal up front, on a
 * path it is about to build ids from. It is public API, which is why it stays.
 *
 * It runs `symbolIdPathViolation` rather than layering on `toDocumentPath`, so a path that
 * breaks the shared rule is still described as a Symbol id path — which is what such a caller
 * was building, and the more useful of the two subjects to be told about.
 */
export function toPosixRelative(rawPath: string): string {
  const normalized = normalizeToNfc(rawPath)
  const violation = symbolIdPathViolation(normalized)
  if (violation !== null) {
    throw new CoreError(violation.message, { code: violation.code, value: violation.value })
  }
  return normalized
}

/**
 * Put every part into Unicode NFC — the form ir-schema.md §1.2 defines every Document
 * string to be in, and the reason an id in memory and the same id on disk are one string.
 *
 * It runs before validation rather than after, so `symbolIdViolation` — which rejects a
 * non-NFC part — describes exactly the ids `isSymbolId` will accept. Normalization cannot
 * introduce a separator: the only characters whose NFC form is ASCII are U+037E, U+1FEF
 * and U+212A, mapping to `;`, a backtick and `K`.
 *
 * The file path and the qualified name can both differ in practice — neither grammar is
 * ASCII-only — and the argument above is what covers them: a decomposed `café` normalizes
 * to a composed one and is checked in that spelling, and nothing it could normalize to is a
 * separator. Only the language token is ASCII by its own grammar and so normalizes to
 * itself.
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
 * `symbolIdPathViolation` rejects both characters in a path.
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
function symbolIdViolation(parts: SymbolIdParts): GrammarViolation | null {
  return (
    languageIdViolation(parts.language) ??
    symbolIdPathViolation(parts.file) ??
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
function unnormalizedViolation(parts: SymbolIdParts): GrammarViolation | null {
  for (const [field, raw] of [
    ["language", parts.language],
    ["file", parts.file],
    ["qualified name", parts.qualifiedName],
  ] as const) {
    if (raw === raw.normalize("NFC")) continue
    return {
      code: "invalid-symbol-id",
      message: `Symbol id ${field} ${describeCodePoints(raw)} is not in Unicode NFC; write it as ${describeCodePoints(raw.normalize("NFC"))}`,
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

/**
 * The rule every path written into the IR obeys: non-empty, POSIX-separated, canonical, and
 * naming somewhere inside the workspace.
 *
 * Exported because `checkIRIntegrity` asks the same question of a document it did not build
 * (ir-schema.md §14 invariant #10), and one implementation is what keeps the two answers
 * equal. A path leaving the workspace is refused because the Document claims to describe
 * that workspace: `workspace.root` anchors every other path in it, so a `..` root or
 * `source.file` names something the Document has no way to be about.
 *
 * `subject` is how the offending field is named in the message, so a caller never edits the
 * string it gets back.
 */
export function posixWorkspaceRelativeViolation(
  path: string,
  subject: string = PATH_SUBJECT,
): GrammarViolation | null {
  if (path.length === 0) {
    return { code: "non-posix-path", message: `${subject} is empty`, value: path }
  }
  // Two producers, and the message has to hold for both: a caller that handed over a native
  // path without converting it, and a file whose name legitimately contains the character.
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
  // A bare "." is the workspace root itself and is the root component's root. Anywhere else
  // a "." segment is a second spelling of a path that already has one — `./src/a.ts` and
  // `src/a.ts` name one file, and two spellings mean two Symbol ids for it, which invariant
  // #1 cannot see as a duplicate. Every producer here goes through `relative()`, which never
  // emits one, so this closes the shape rather than rejecting anything Aburi writes.
  if (path !== "." && segments.some((s) => s === ".")) {
    return {
      code: "non-posix-path",
      message: `${subject} "${path}" contains a "." segment; a path has one spelling, and "${segments.filter((s) => s !== ".").join("/")}" is it`,
      value: path,
    }
  }
  return null
}

/**
 * The path rule plus the one restriction that belongs to the id rather than to the path.
 *
 * `:` and `#` are the id's own separators, so a path holding either assembles into a string
 * whose first `:` / `#` fall in the wrong place: it still satisfies the schema pattern, but
 * splitting it back yields parts the producer never wrote. A component root is not split on
 * anything, which is why this sits here and not in the shared rule. Checked after the path
 * rule so a Windows drive path still reports the more useful "is absolute".
 *
 * The bare "." is refused here for the same reason: it is the workspace root, a legitimate
 * `components[].roots` entry and never a `symbols[].source.file`, because a directory holds
 * no Symbol.
 */
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
      message: `${SYMBOL_ID_PATH_SUBJECT} "${path}" contains ":" or "#", the two Symbol id separators (ir-schema.md §3.1)`,
      value: path,
    }
  }
  return null
}

/**
 * Does a string satisfy the qualified-name grammar of ir-schema.md §3.1?
 *
 * `Symbol.name` carries a qualified name too, and `lastQnameSegment` is called on it by
 * `apiFingerprint` and by two framework classifiers. Nothing ties it to the qname inside
 * `Symbol.id`, so checking the id alone leaves the value those three actually read
 * unchecked. Invariant #17 uses this on both.
 */
export function isQualifiedName(value: string): boolean {
  return qualifiedNameViolation(value) === null
}

/**
 * Is a single string a segment the qualified-name grammar admits?
 *
 * For a producer holding a *candidate* name with somewhere to go other than a throw. A
 * language plugin reads names the grammar has no segment for — a quoted or numeric class
 * member, a computed one — and for those `ir-schema.md` §3.2 says no Symbol rather than an
 * error, so the plugin has to ask before it builds. Without this it could only build and
 * catch, and catching an id-builder throw means catching every other reason one is thrown.
 *
 * `isQualifiedName` is the wrong predicate for that question and would fail quietly: it
 * answers about a *finished* name, so it admits `.` and `::`. A caller vetting one member
 * name with it would accept `"a.b"` and mint the nested qname `C.a.b` out of a single member.
 */
export function isQnameSegment(value: string): boolean {
  return QNAME_SEGMENT_PATTERN.test(value)
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
  for (const segment of splitQnameSegments(qname)) {
    if (segment.length === 0) {
      return {
        code: "anonymous-symbol-id-attempted",
        message: `qualified name "${qname}" has an empty segment; "." and "::" join two named constructs, so neither may sit at an end or beside another`,
        value: qname,
      }
    }
    if (!QNAME_SEGMENT_PATTERN.test(segment)) {
      return {
        code: "anonymous-symbol-id-attempted",
        message: `qualified name "${qname}" contains the non-identifier segment "${segment}"`,
        value: qname,
      }
    }
  }
  return null
}

/**
 * Split a fully-built qname back into the segments that must each pass the identifier
 * pattern. Both the instance separator (".") and the static separator ("::") split here.
 *
 * Empty segments are kept rather than dropped. Discarding them made a dangling separator
 * invisible to the check above: `A.` split to `["A"]` and satisfied the constructor, so an
 * id no producer is able to build passed every gate that exists to stop one. An empty
 * segment is the defect, so it has to reach the validator that reports it.
 */
function splitQnameSegments(qname: string): string[] {
  return qname.split(/::|\./)
}

function assertQnameSegment(segment: string, originalQname: string): void {
  if (!QNAME_SEGMENT_PATTERN.test(segment)) {
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
