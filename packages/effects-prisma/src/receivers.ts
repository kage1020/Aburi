import { identifierMentions, receiverConfidence } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, Confidence } from "@aburi/types"

const PRISMA_CLIENT_WORDS_LIST = ["prisma", "db", "database", "orm", "tx", "trx"] as const

export type PrismaClientWord = (typeof PRISMA_CLIENT_WORDS_LIST)[number]

export const PRISMA_CLIENT_WORDS: ReadonlySet<PrismaClientWord> = new Set(PRISMA_CLIENT_WORDS_LIST)

/** True when `segment` spells a word this package recognizes as a Prisma client binding. */
export function namesPrismaClient(segment: string): boolean {
  return identifierMentions(segment, PRISMA_CLIENT_WORDS as ReadonlySet<string>)
}

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
