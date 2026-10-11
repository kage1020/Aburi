import { identifierMentions, receiverConfidence } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, Confidence } from "@aburi/types"

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

export function namesDrizzleClient(segment: string): boolean {
  return identifierMentions(segment, DRIZZLE_CLIENT_WORDS as ReadonlySet<string>)
}

export function classificationConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
  maxArguments: number,
): Confidence {
  return receiverConfidence(clientSegment, call, maxArguments, namesDrizzleClient)
}
