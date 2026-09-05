import { hasLiteralFirstArgument, identifierMentions } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, Confidence } from "@aburi/types"

/**
 * The words a Drizzle database binding is spelled with.
 *
 * A classifier only ever sees the callee string, so "which local binding holds the client"
 * is not a question it can answer outright — the `drizzle(...)` call that produced the
 * binding is in the AST, which effect plugins deliberately never see (effect-plugin.md
 * §11.1). What the callee does carry is the name the author gave that binding, and
 * Drizzle's own docs and every published starter spell it from this handful of words.
 *
 * Matching is per word (`identifierWords`), so `db`, `dbClient`, `readReplicaDb`,
 * `drizzleDb` and `_db` all count, while `router`, `store`, `queue` and `cache` do not.
 * That is the whole point: Drizzle's root verbs are 2-segment (`db.delete(...)`), which is
 * the same shape as `router.delete(...)` — and Express + Drizzle is a common enough pairing
 * that the file-level import gate does not separate them.
 *
 * `tx` / `trx` / `transaction` are here because the interactive-transaction callback binds
 * the client under its own parameter name — `db.transaction(async (tx) =>
 * tx.insert(users)...)` — and that statement is as much a write as the one outside it.
 *
 * A literal source of truth, like every other vocabulary in this package: extending it for
 * a house naming convention is a table edit in exactly one place.
 */
const DRIZZLE_CLIENT_WORDS_LIST = [
  "drizzle",
  "db",
  "database",
  "client",
  "conn",
  "connection",
  "orm",
  "tx",
  "trx",
  "transaction",
] as const

export type DrizzleClientWord = (typeof DRIZZLE_CLIENT_WORDS_LIST)[number]

export const DRIZZLE_CLIENT_WORDS: ReadonlySet<DrizzleClientWord> = new Set(
  DRIZZLE_CLIENT_WORDS_LIST,
)

/** True when `segment` spells a word this package recognizes as a Drizzle client binding. */
export function namesDrizzleClient(segment: string): boolean {
  return identifierMentions(segment, DRIZZLE_CLIENT_WORDS as ReadonlySet<string>)
}

/**
 * How much the receiver backs the classification the terminal suggests.
 *
 * - `high` — the receiver segment names a client binding, so the call is a Drizzle query in
 *   a file that imports Drizzle with a terminal from Drizzle's own vocabulary.
 * - `medium` — everything else matched but the receiver did not: either it is a binding
 *   this plugin cannot recognize by name (a house convention, a client reached through a
 *   wrapper) or it is an unrelated object that happens to share the verb. A syntactic
 *   classifier cannot separate those two without the binding table it has no access to, so
 *   it says so in `confidence` rather than picking one and being confidently wrong half the
 *   time. `medium` is the same tier `@aburi/framework-express` uses for a route that
 *   matches the shape without an import anchor.
 *
 * A dynamic receiver (`getDb().select()`, `pools[0].insert(users)`) is capped at `medium`
 * whatever it is spelled: normalization collapsed an expression down to a name, so the name
 * in `target` is not a binding at all and reading it as one would manufacture evidence out
 * of a call the language plugin already flagged as unresolvable
 * (`CallCandidate.dynamicReceiver`).
 */
export function receiverConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
): Confidence {
  if (call.dynamicReceiver === true) return "medium"
  if (clientSegment !== undefined && namesDrizzleClient(clientSegment)) return "high"
  return "medium"
}

/**
 * True when the call's arguments fit a Drizzle query-builder root taking at most
 * `maxArguments` of them (`maxBuilderArguments` reads that off the terminal).
 *
 * `select` takes an optional projection object, `insert` / `update` / `delete` take one
 * table reference, the relational query terminals take an optional options object, and
 * Postgres' `selectDistinctOn` takes two — but none of them takes a bare literal.
 * `router.delete("/users/:id", handler)` breaks both rules at once, which is what lets this
 * reject the Express collision outright instead of leaving it to the receiver's name.
 */
export function hasBuilderArgumentShape(call: CallCandidate, maxArguments: number): boolean {
  return call.argumentCount <= maxArguments && !hasLiteralFirstArgument(call)
}

/**
 * True when the call's arguments fit `transaction` / `batch`.
 *
 * Looser than `hasBuilderArgumentShape` on arity by design: `db.transaction(cb, config)`
 * passes a second options argument, so only the literal check applies — a transaction takes
 * a callback or an array of statements, never `"a string"`.
 */
export function hasTransactionArgumentShape(call: CallCandidate): boolean {
  return !hasLiteralFirstArgument(call)
}
