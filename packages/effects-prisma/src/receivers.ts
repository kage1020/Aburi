import { identifierMentions, receiverConfidence } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, Confidence } from "@aburi/types"

/**
 * The words a Prisma Client binding is spelled with. The callee string is all a classifier
 * sees (effect-plugin.md), and matching is per word (`identifierWords`): `prisma`,
 * `prismaClient`, `readReplicaDb` and `_prisma` count; `cache`, `router`, `items` and
 * `feedback` do not. `tx` / `trx` cover the interactive-transaction callback parameter.
 *
 * Deliberately absent: `client`, which would hand an SDK's `apiClient.users.update(payload)`
 * — spelled exactly like a delegate call — a high-confidence `db.write`; `transaction`,
 * which names a domain noun (`paymentTransaction`) far more often than a client; and
 * `datasource`, which `identifierWords("dataSource")` splits so only the all-lowercase form
 * ever matched. See docs/design/effect-plugin.md.
 */
const PRISMA_CLIENT_WORDS_LIST = ["prisma", "db", "database", "orm", "tx", "trx"] as const

export type PrismaClientWord = (typeof PRISMA_CLIENT_WORDS_LIST)[number]

export const PRISMA_CLIENT_WORDS: ReadonlySet<PrismaClientWord> = new Set(PRISMA_CLIENT_WORDS_LIST)

/** True when `segment` spells a word this package recognizes as a Prisma client binding. */
export function namesPrismaClient(segment: string): boolean {
  return identifierMentions(segment, PRISMA_CLIENT_WORDS as ReadonlySet<string>)
}

/**
 * The most arguments a Prisma call takes before it stops looking like Prisma's own API: a
 * delegate method takes one options object or nothing; `$transaction(fn, { timeout })`
 * takes two.
 */
export const PRISMA_DELEGATE_MAX_ARGUMENTS = 1
export const PRISMA_TRANSACTION_MAX_ARGUMENTS = 2

/** `receiverConfidence` under this package's client vocabulary. */
export function classificationConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
  maxArguments: number,
): Confidence {
  return receiverConfidence(clientSegment, call, maxArguments, namesPrismaClient)
}
