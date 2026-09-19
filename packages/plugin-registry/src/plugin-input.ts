// Fail-fast guards and shared readers over the values a language plugin hands to an effect
// plugin, plus the few helpers every effects plugin would otherwise repeat verbatim (its
// manifest shape, its import gate predicate, its receiver-confidence rule).
//
// Deliberately import-light: this module pulls in nothing but types from `@aburi/types`,
// which is what lets it ship as the `@aburi/plugin-registry/plugin-input` subpath without
// dragging the barrel's eager ajv schema compilation into every effect plugin's startup.
// Keep it that way — a value import from a sibling module here would silently undo it.

import type { CallCandidate, Confidence, ImportEdge } from "@aburi/types"

/**
 * A `.`-split callee target that has been checked for emptiness. The tuple shape records
 * that the first segment exists, so callers index it without a cast under
 * `noUncheckedIndexedAccess`.
 */
export type NonEmptySegments = readonly [string, ...string[]]

/**
 * Who is asking, and about which file. Threaded into every thrown message so a caught
 * exception in production tooling (CI logs, error reporters) points at the offending
 * source file instead of a bare "empty target" string.
 *
 * Passed as a record rather than two positional strings: `plugin` and `filePath` are both
 * plain strings, so a positional pair would let a transposed call type-check and only
 * surface as a scrambled error message at the worst possible moment.
 */
export interface PluginInputOrigin {
  /** Plugin name used as the message prefix, e.g. `"effects-drizzle"`. */
  readonly plugin: string
  /** Path of the source file the candidate came from. */
  readonly filePath: string
}

/**
 * The two views of a validated target that classifiers actually consume: the full segment
 * list, and the terminal segment they dispatch on. Returning `last` separately is what
 * removes the `parts.at(-1) as string` cast from every call site — `at()` widens to
 * `string | undefined` even on a tuple.
 */
export interface CallTargetSegments {
  readonly segments: NonEmptySegments
  readonly last: string
}

/**
 * Split `target` on `.` and reject any shape a well-formed language plugin would never
 * emit: an empty target, or one with an empty segment (leading, trailing, or adjacent
 * dots). A malformed target would otherwise slip through a classifier's length gate and
 * false-classify — `"prisma..create"` has three segments and would match a write verb.
 *
 * **Call this before the plugin's import gate, not after.** Both orders detect the same
 * violations, but gating first narrows detection to the files that import the plugin's
 * library — so an upstream normalization bug reproduces only in that slice and looks
 * library-specific instead of what it is. Checking first does not reach every file either
 * (a dropped symbol or a category-C call never gets classified at all), but it removes the
 * one bias that would actively mislead whoever debugs it.
 *
 * A thrown error is an upstream contract violation, not a classification decision, and
 * effect-plugin.md EP3a exempts it from the "a throwing classifier is treated as
 * `null`" rule: it propagates rather than resolving to an unclassified call. The core's
 * per-file boundary (lang-plugin.md) is what decides the cost — the file is withdrawn,
 * named, and quoted back with this message, and the scan exits non-zero. Degrading the
 * throw here instead would convert a language plugin bug into a quietly under-populated IR,
 * which is the outcome this guard exists to prevent.
 */
export function assertNonEmptySegments(
  target: string,
  origin: PluginInputOrigin,
): CallTargetSegments {
  const where = `${origin.plugin} (${origin.filePath})`
  if (target.length === 0) {
    throw new Error(
      `${where}: CallCandidate.target is empty — language plugin emitted an unnormalized callee`,
    )
  }

  // The `= ""` default is what narrows `first` to `string` without a cast, and it needs no
  // branch of its own: `String.prototype.split` never returns an empty array, and if it
  // somehow did, the empty default falls straight into the empty-segment rejection below.
  const [first = "", ...rest] = target.split(".")

  const emptySegment = `${where}: CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`
  if (first.length === 0) throw new Error(emptySegment)

  // `last` is carried through the validation loop rather than read back by index: a
  // trailing-index read widens to `string | undefined` under noUncheckedIndexedAccess even
  // on a tuple, and re-introducing a cast here would defeat the point of this function.
  let last = first
  for (const segment of rest) {
    if (segment.length === 0) throw new Error(emptySegment)
    last = segment
  }

  return { segments: [first, ...rest], last }
}

/**
 * Reject an import edge the language plugin should never have emitted: a module specifier
 * of zero length. Nothing downstream can act on it — it names no module, so a provenance
 * check would silently answer "not from my package" and an unresolved-import diagnostic
 * would name nothing.
 *
 * Callers that walk the edge list themselves must call this on every edge **before**
 * answering, not just on the ones they end up using: an answer that depends on which edges
 * a predicate happened to reach makes the throw depend on import order.
 */
export function assertImportEdgeSource(edge: ImportEdge, origin: PluginInputOrigin): void {
  if (edge.source.length > 0) return
  throw new Error(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.source is empty — language plugin emitted an unnormalized import edge`,
  )
}

/**
 * The two halves of one `ImportEdge.symbols` entry, as the caller recovered them.
 *
 * Taken as a parameter rather than split here: the wire format's parser lives in
 * `@aburi/core` (`splitAliasedImportName`), and importing a value from it would fold this
 * module back into the barrel's graph — the one thing the header forbids. Callers already
 * hold the split, so passing it costs nothing and keeps the format's definition in one place.
 */
export interface ImportBindingHalves {
  readonly imported: string
  readonly local: string
}

/**
 * Reject a `symbols` entry whose exported or local half is empty — `" as Y"`, `"X as "`, or
 * an entry that is empty outright.
 *
 * An empty half is not a name, and a plugin that matches names against a vocabulary table
 * will look up `""`, miss every entry, and drop the classification with nothing recording
 * that anything was skipped. That is the same disappearing act `assertImportEdgeSource`
 * refuses for a module specifier, arriving through the other field of the same edge — and
 * unlike a specifier, an empty half can take a whole class's `extKind` with it, because the
 * decorator it belongs to stops matching.
 *
 * Guarding only the local half is not enough. The exported half is the one that reaches the
 * table, and a caller that skips an entry on an empty local name hands the written name back
 * to its own "no edge mentions this" branch, which is generally the most trusting one.
 */
export function assertImportBinding(
  binding: ImportBindingHalves,
  raw: string,
  edge: ImportEdge,
  origin: PluginInputOrigin,
): void {
  if (binding.imported.length > 0 && binding.local.length > 0) return
  throw new Error(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.symbols entry "${raw}" has an empty half — language plugin emitted an unnormalized import edge`,
  )
}

/**
 * True when any import edge's module specifier satisfies `matches`, after every edge has
 * been checked for an empty `source`.
 *
 * The validation pass runs across the whole list *before* the match check, so throw
 * behaviour does not depend on import order — a `.some()` that validated inline would
 * short-circuit on the first match and never notice a broken edge sitting behind it.
 * Bundling the two passes into one function is what makes that ordering unforgeable:
 * there is no way to ask "does this file import X?" while skipping the validation.
 *
 * `matches` receives the specifier string alone rather than the whole `ImportEdge`. Not
 * for safety — validation has already run over every edge by the time the predicate is
 * called, so a wider argument could not skip it. It is the smaller surface: every current
 * caller matches on the specifier, and widening the argument later stays compatible while
 * narrowing it would not.
 */
export function hasMatchingImport(
  imports: readonly ImportEdge[],
  origin: PluginInputOrigin,
  matches: (source: string) => boolean,
): boolean {
  for (const edge of imports) assertImportEdgeSource(edge, origin)
  return imports.some((edge) => matches(edge.source))
}

/**
 * The words an identifier spells, lowercased and in source order: `prismaClient` →
 * `["prisma", "client"]`, `read_replica_db` → `["read", "replica", "db"]`, `_prisma` →
 * `["prisma"]`, `DBClient` → `["db", "client"]`.
 *
 * This is what lets a classifier ask whether a receiver segment *names* the client it is
 * about to attribute an effect to, instead of trusting the call's shape alone. A raw
 * substring test cannot: `"db"` is inside `"feedback"` and `"tx"` is inside `"context"`,
 * so a receiver called `feedback` would answer yes to both. Splitting on case and
 * separator boundaries first asks the question the naming convention actually answers —
 * "is one of the words in this name the client's word".
 *
 * Digits are boundaries, not words: `db2` gives `["db"]`, and `v2Client` gives
 * `["v", "client"]`. A vocabulary is a set of words, so a numeric chunk could only ever
 * miss, and dropping it keeps `db2` matching the same vocabulary entry `db` does.
 */
export function identifierWords(name: string): string[] {
  const words: string[] = []
  for (const chunk of name.split(/[^A-Za-z0-9]+/)) {
    // `[A-Z]+(?![a-z])` takes an acronym run whole (`DBClient` → `DB`, `Client`), and
    // `[A-Z]?[a-z]+` takes an ordinary camel word with its leading capital if it has one.
    for (const word of chunk.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []) {
      words.push(word.toLowerCase())
    }
  }
  return words
}

/**
 * True when any word of `name` (per `identifierWords`) is in `vocabulary`.
 *
 * The vocabulary belongs to the calling plugin — Prisma's client words are not Drizzle's —
 * so this holds only the splitting rule the two share, in one place where it can be tested
 * once instead of drifting per plugin.
 */
export function identifierMentions(name: string, vocabulary: ReadonlySet<string>): boolean {
  return identifierWords(name).some((word) => vocabulary.has(word))
}

/**
 * True when the call's first argument was a literal (`"users"`, `42`, `true`, `null`).
 *
 * The negative is what classifiers use: an ORM client method takes a table reference, an
 * options object or a callback, never a bare literal — so `router.delete("/users/:id", h)`
 * is not the `db.delete(users)` it shares a method name with. Reading `literalArgs[0]`
 * inline instead would need the `?? null` on every call site to survive
 * `noUncheckedIndexedAccess`, which is exactly the kind of detail that gets one site wrong.
 *
 * A call with no arguments answers `false`: there is no first argument to be a literal, and
 * a zero-argument call is a shape its own arity check should decide on, not this one.
 */
export function hasLiteralFirstArgument(call: Pick<CallCandidate, "literalArgs">): boolean {
  return (call.literalArgs[0] ?? null) !== null
}

/**
 * A predicate for `hasMatchingImport` that accepts a module root exactly or as a `<root>/`
 * subpath: `matchesModuleOrSubpath("drizzle-orm")` accepts `drizzle-orm` and
 * `drizzle-orm/postgres-js` but not `drizzle-orm-mock`. The `/` is what keeps third-party
 * lookalikes out; libraries that ship deep entry points and move them between minors need
 * this rather than a closed allowlist of full specifiers.
 */
export function matchesModuleOrSubpath(...roots: readonly string[]): (source: string) => boolean {
  return (source) => roots.some((root) => source === root || source.startsWith(`${root}/`))
}

/**
 * How much a call backs the classification its terminal suggests, for a plugin that
 * attributes effects to a client binding it can only see by name.
 *
 * `high` needs every signal to agree: the receiver segment names a client binding (per the
 * plugin's own `namesClient` vocabulary), the receiver is a binding at all rather than a
 * collapsed expression, and the call takes no more arguments than the terminal's signature
 * allows. Anything else is `medium` — the effect is still recorded, with the uncertainty
 * stated, because each of the three failures is ambiguous rather than disqualifying:
 *
 * - An unrecognized receiver is either a client under a house naming convention or an
 *   unrelated object sharing the verb. A syntactic classifier cannot separate the two, so it
 *   says so in `confidence` instead of dropping the first or confidently claiming the second.
 * - A dynamic receiver (`getDb().select()`, `pools[0].insert(users)`) was collapsed to a name
 *   by normalization, so the name in `target` is not a binding and its spelling is not
 *   evidence (`CallCandidate.dynamicReceiver`).
 * - An argument list longer than the terminal takes is evidence against, not proof:
 *   `argumentCount` is a syntactic count, and treating an overflow as "not this library"
 *   would let one miscount erase a real write with nothing logged.
 *
 * A literal first argument is not a tier question and is not decided here: no ORM client
 * method takes one, so callers reject it outright (`hasLiteralFirstArgument`).
 */
export function receiverConfidence(
  clientSegment: string | undefined,
  call: Pick<CallCandidate, "dynamicReceiver" | "argumentCount">,
  maxArguments: number,
  namesClient: (segment: string) => boolean,
): Confidence {
  if (call.dynamicReceiver === true) return "medium"
  if (call.argumentCount > maxArguments) return "medium"
  if (clientSegment !== undefined && namesClient(clientSegment)) return "high"
  return "medium"
}

/**
 * The manifest shape shared by every first-party effects plugin, with the two literals a
 * plugin actually chooses kept narrow so consumers can compare against them.
 *
 * Declared standalone rather than `extends EffectsManifest` on purpose. Extending would
 * inherit `PluginManifest`'s optional `xPrefix` and `capabilities`, and a first-party
 * effects manifest sets neither — `xPrefix` is the registry's to derive from `name`
 * (`deriveXPrefix`), which is what `defineEffectsManifest`'s docblock relies on. Inheriting
 * them would make `manifest.xPrefix` a well-typed read of a key no manifest here carries,
 * so the mistake would surface as a silent `undefined` instead of a compile error.
 * Dropping `extends` also drops the compiler's check that this shape still satisfies the
 * contract the registry validates against, so `plugin-input.test.ts` states it instead: it
 * assigns a built manifest to an `EffectsManifest` and asserts that `xPrefix` stays
 * unreadable, which fails `pnpm typecheck` if either half stops holding.
 */
export interface EffectsPluginManifest<Name extends string, DerivedByPrefix extends string> {
  readonly $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json"
  readonly name: Name
  readonly version: "0.0.0"
  readonly type: "effects"
  readonly engines: { readonly aburi: "*" }
  readonly provides: {
    readonly effects: []
    readonly effectPrefixes: []
    readonly extKinds: []
    readonly extKindPrefixes: []
    readonly derivedByPrefixes: [DerivedByPrefix]
    readonly frameworks: []
  }
}

/**
 * Manifest for an effects plugin that classifies onto core-owned effect ids only.
 *
 * `provides.effects` is empty by design: core vocabulary (`db.*`, `event.*`, `network.*`)
 * lives in the reserved namespace and MUST NOT appear there (extension-vocab.md). The
 * plugin's own `x-<name>:*` namespace is reserved via the `xPrefix` the registry derives
 * from `name` (`deriveXPrefix`) and currently claims no bindings. `extKinds` and
 * `frameworks` are empty by contract — an effects manifest declaring either is a schema
 * error (extension-vocab.md). `derivedByPrefixes` takes the same constant the
 * classifier builds its tags from, so the two cannot drift.
 */
export function defineEffectsManifest<Name extends string, DerivedByPrefix extends string>(
  name: Name,
  derivedByPrefix: DerivedByPrefix,
): EffectsPluginManifest<Name, DerivedByPrefix> {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name,
    version: "0.0.0",
    type: "effects",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [derivedByPrefix],
      frameworks: [],
    },
  }
}
