import { identifierMentions } from "@aburi/plugin-registry/plugin-input"
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
 * `tx` / `trx` are here because the interactive-transaction callback binds the client under
 * its own parameter name — `db.transaction(async (tx) => tx.insert(users)...)` — and that
 * statement is as much a write as the one outside it.
 *
 * **What is deliberately not here.** A word only earns a place if it separates a database
 * client from everything else that shares Drizzle's verbs:
 *
 * - `client` matches `httpClient`, `apiClient`, `redisClient`, `s3Client` — so
 *   `httpClient.delete(url)` would read as a `db.write` at the tier a hand-annotated
 *   effect gets. That is the bug this whole module exists to close, under what is
 *   probably the most common non-database binding name there is. Every positive example
 *   in this package (`dbClient`, `drizzleDb`, `readReplicaDb`) matches on another word
 *   regardless; a bare `client.select()` is what the entry would have bought, and it is
 *   not worth the collision.
 * - `transaction` matches the domain nouns `paymentTransaction` / `transactionLog` far
 *   more often than it names a client. The `tx` / `trx` spellings of the callback
 *   parameter cover the idiom, and a parameter literally named `transaction` still
 *   records its write — at `medium`.
 *
 * A literal source of truth, like every other vocabulary in this package: extending it for
 * a house naming convention is a table edit in exactly one place.
 */
const DRIZZLE_CLIENT_WORDS_LIST = [
  "drizzle",
  "db",
  "database",
  "conn",
  "connection",
  "orm",
  "tx",
  "trx",
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
 * How much the call backs the classification its terminal suggests.
 *
 * `high` needs every signal to agree: the receiver segment names a client binding, the
 * receiver is a binding at all rather than a collapsed expression, and the call takes no
 * more arguments than the terminal's own signature allows (`maxArgumentsFor`).
 * Anything else is `medium` — the effect is still recorded, with the uncertainty stated:
 *
 * - **An unrecognized receiver** is either a binding this plugin cannot place by name (a
 *   house convention, a client reached through a wrapper) or an unrelated object that
 *   happens to share the verb. A syntactic classifier cannot separate those two without
 *   the binding table it has no access to, so it says so in `confidence` rather than
 *   picking one and being confidently wrong half the time. `medium` is the same tier
 *   `@aburi/framework-express` uses for a route that matches the shape without an import
 *   anchor.
 * - **A dynamic receiver** (`getDb().select()`, `pools[0].insert(users)`) is capped at
 *   `medium` whatever it is spelled: normalization collapsed an expression down to a name,
 *   so the name in `target` is not a binding and reading it as one would manufacture
 *   evidence out of a call the language plugin already flagged as unresolvable
 *   (`CallCandidate.dynamicReceiver`).
 * - **An argument list longer than the terminal takes** is evidence against, not proof:
 *   `argumentCount` comes from a syntactic walk, and this classifier is the first thing to
 *   read it as a signature. Treating an overflow as "not a Drizzle call" would let one
 *   miscount erase a real write and log nothing — the failure mode with no trace. So it
 *   costs the tier instead, which is this module's own rule applied to its own inputs.
 *
 * A literal first argument is the one shape that is *not* a tier question, and it is not
 * decided here: no Drizzle root takes one, so `classifyDrizzleCall` rejects it outright.
 */
export function classificationConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
  maxArguments: number,
): Confidence {
  if (call.dynamicReceiver === true) return "medium"
  if (call.argumentCount > maxArguments) return "medium"
  if (clientSegment !== undefined && namesDrizzleClient(clientSegment)) return "high"
  return "medium"
}
