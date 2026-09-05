import { identifierMentions } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, Confidence } from "@aburi/types"

/**
 * The words a Prisma Client binding is spelled with.
 *
 * A classifier only ever sees the callee string, so "which local binding holds the client"
 * is not a question it can answer outright — the assignment that created the binding
 * (`const prisma = new PrismaClient()`, `constructor(private prisma: PrismaClient)`) is in
 * the AST, which effect plugins deliberately never see (effect-plugin.md §11.1). What the
 * callee does carry is the name the author gave that binding, and Prisma's own docs, the
 * generated client, and every published starter spell it from this handful of words.
 *
 * Matching is per word (`identifierWords`), so `prismaClient`, `readReplicaDb`, `_prisma`,
 * `dbClient` and `prismaRo` all count, while `cache`, `router`, `items` and `store` do not.
 * That is the whole point: `delete`, `create` and `update` are shared vocabulary across
 * `Map`, `Set`, the DOM and every HTTP router, and `this.<x>.<y>.delete(...)` is everyday
 * TypeScript, so the method name plus a file-level import gate is not evidence that the
 * receiver is a database client.
 *
 * `tx` / `trx` are here because the interactive-transaction callback rebinds the client
 * under its own parameter name — `prisma.$transaction(async (tx) => tx.user.create(...))` —
 * and that call is as much a write as the one outside it.
 *
 * **What is deliberately not here.** A word only earns a place if it separates a database
 * client from everything else that shares Prisma's verbs:
 *
 * - `client` matches `apiClient`, `httpClient`, `redisClient`, `sdkClient`. A resource
 *   SDK's `<client>.<resource>.<verb>` is spelled exactly like a Prisma delegate, so
 *   `apiClient.users.update(payload)` would land at the tier a hand-annotated effect gets
 *   — the bug class this module exists to close. `prismaClient`, `dbClient` and `_prisma`
 *   match on `prisma` or `db` regardless; a bare `client.user.create()` is all the entry
 *   would have bought.
 * - `transaction` matches the domain nouns `paymentTransaction` / `transactionLog` more
 *   often than it names a client, and `tx` / `trx` already cover the callback parameter.
 * - `datasource` was unreachable as anyone spells it: `identifierWords("dataSource")` is
 *   `["data", "source"]`, so only the all-lowercase form ever matched.
 *
 * A literal source of truth, like every other vocabulary in this package: extending it for
 * a house naming convention is a table edit in exactly one place.
 */
const PRISMA_CLIENT_WORDS_LIST = ["prisma", "db", "database", "orm", "tx", "trx"] as const

export type PrismaClientWord = (typeof PRISMA_CLIENT_WORDS_LIST)[number]

export const PRISMA_CLIENT_WORDS: ReadonlySet<PrismaClientWord> = new Set(PRISMA_CLIENT_WORDS_LIST)

/** True when `segment` spells a word this package recognizes as a Prisma client binding. */
export function namesPrismaClient(segment: string): boolean {
  return identifierMentions(segment, PRISMA_CLIENT_WORDS as ReadonlySet<string>)
}

/**
 * The most arguments a Prisma call takes before it stops looking like Prisma's own API.
 *
 * A model delegate method takes a single options object (`{ where }`, `{ data }`) or
 * nothing at all. `$transaction` takes two: the callback form carries an options object
 * (`$transaction(fn, { timeout })`), while the array form takes one.
 */
export const PRISMA_DELEGATE_MAX_ARGUMENTS = 1
export const PRISMA_TRANSACTION_MAX_ARGUMENTS = 2

/**
 * How much the call backs the classification its method name suggests.
 *
 * `high` needs every signal to agree: the receiver segment names a client binding, the
 * receiver is a binding at all rather than a collapsed expression, and the call takes no
 * more arguments than the API allows. Anything else is `medium` — the effect is still
 * recorded, with the uncertainty stated:
 *
 * - **An unrecognized receiver** is either a binding this plugin cannot place by name (a
 *   house convention, a client reached through a wrapper) or an unrelated object that
 *   happens to share the verb. A syntactic classifier cannot separate those two without
 *   the binding table it has no access to, so it says so in `confidence` rather than
 *   picking one and being confidently wrong half the time. `medium` is the same tier
 *   `@aburi/framework-express` uses for a route that matches the shape without an import
 *   anchor.
 * - **A dynamic receiver** (`getClient().user.create()`, `clients[0].user.create()`) is
 *   capped at `medium` whatever it is spelled: normalization collapsed an expression down
 *   to a name, so the name in `target` is not a binding and reading it as one would
 *   manufacture evidence out of a call the language plugin already flagged as unresolvable
 *   (`CallCandidate.dynamicReceiver`).
 * - **An argument list longer than the API takes** is evidence against, not proof:
 *   `argumentCount` comes from a syntactic walk, and this classifier is the first thing to
 *   read it as a signature. Treating an overflow as "not a Prisma call" would let one
 *   miscount erase a real write and log nothing — the failure mode with no trace. So it
 *   costs the tier instead, which is this module's own rule applied to its own inputs.
 *
 * A literal first argument is the one shape that is *not* a tier question, and it is not
 * decided here: `prisma.user.delete("u1")` is a type error rather than a Prisma call, so
 * `classifyPrismaCall` rejects it outright.
 */
export function classificationConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
  maxArguments: number,
): Confidence {
  if (call.dynamicReceiver === true) return "medium"
  if (call.argumentCount > maxArguments) return "medium"
  if (clientSegment !== undefined && namesPrismaClient(clientSegment)) return "high"
  return "medium"
}
