import { hasLiteralFirstArgument, identifierMentions } from "@aburi/plugin-registry/plugin-input"
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
 * `tx` / `trx` / `transaction` are here because the interactive-transaction callback
 * rebinds the client under its own parameter name — `prisma.$transaction(async (tx) =>
 * tx.user.create(...))` — and that call is as much a write as the one outside it.
 *
 * A literal source of truth, like every other vocabulary in this package: extending it for
 * a house naming convention is a table edit in exactly one place.
 */
const PRISMA_CLIENT_WORDS_LIST = [
  "prisma",
  "db",
  "database",
  "client",
  "datasource",
  "orm",
  "tx",
  "trx",
  "transaction",
] as const

export type PrismaClientWord = (typeof PRISMA_CLIENT_WORDS_LIST)[number]

export const PRISMA_CLIENT_WORDS: ReadonlySet<PrismaClientWord> = new Set(PRISMA_CLIENT_WORDS_LIST)

/** True when `segment` spells a word this package recognizes as a Prisma client binding. */
export function namesPrismaClient(segment: string): boolean {
  return identifierMentions(segment, PRISMA_CLIENT_WORDS as ReadonlySet<string>)
}

/**
 * How much the receiver backs the classification the method name suggests.
 *
 * - `high` — the receiver segment names a client binding, so the call is a Prisma call in
 *   a file that imports Prisma with a method only the Prisma delegate surface has.
 * - `medium` — everything else matched but the receiver did not: either it is a binding
 *   this plugin cannot recognize by name (a house convention, a client reached through a
 *   wrapper) or it is an unrelated object that happens to share the verb. A syntactic
 *   classifier cannot separate those two without the binding table it has no access to, so
 *   it says so in `confidence` rather than picking one and being confidently wrong half the
 *   time. `medium` is the same tier `@aburi/framework-express` uses for a route that
 *   matches the shape without an import anchor.
 *
 * A dynamic receiver (`getClient().user.create()`, `clients[0].user.create()`) is capped at
 * `medium` whatever it is spelled: normalization collapsed an expression down to a name, so
 * the name in `target` is not a binding at all and reading it as one would manufacture
 * evidence out of a call the language plugin already flagged as unresolvable
 * (`CallCandidate.dynamicReceiver`).
 */
export function receiverConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
): Confidence {
  if (call.dynamicReceiver === true) return "medium"
  if (clientSegment !== undefined && namesPrismaClient(clientSegment)) return "high"
  return "medium"
}

/**
 * True when the call's arguments fit a Prisma model delegate.
 *
 * Every delegate method takes a single options object (`{ where }`, `{ data }`) or nothing
 * at all — `prisma.user.delete("u1")` and `prisma.user.update(a, b)` are both type errors,
 * not Prisma calls. `Map.prototype.delete(key)` and `router.delete(path, handler)` are not,
 * which is what makes the shape worth checking: it costs no recall and it takes a slice of
 * the collisions the receiver check has to weigh in on.
 */
export function hasDelegateArgumentShape(call: CallCandidate): boolean {
  return call.argumentCount <= 1 && !hasLiteralFirstArgument(call)
}
