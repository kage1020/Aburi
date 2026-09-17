import { identifierMentions, receiverConfidence } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, Confidence } from "@aburi/types"

/**
 * The words a Drizzle database binding is spelled with. The callee string is all a
 * classifier sees (effect-plugin.md), and matching is per word (`identifierWords`):
 * `db`, `dbClient`, `readReplicaDb` and `_db` count; `router`, `store` and `feedback` do
 * not. `tx` / `trx` cover the interactive-transaction callback parameter.
 *
 * Deliberately absent: `client`, which would hand `httpClient.delete(url)` / `apiClient` /
 * `s3Client` a high-confidence `db.write`, and `transaction`, which names a domain noun
 * (`paymentTransaction`) far more often than a client. See docs/design/effect-plugin.md.
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

/** `receiverConfidence` under this package's client vocabulary. */
export function classificationConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
  maxArguments: number,
): Confidence {
  return receiverConfidence(clientSegment, call, maxArguments, namesDrizzleClient)
}
