import { identifierMentions, receiverConfidence } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, Confidence } from "@aburi/types"

const PRISMA_CLIENT_WORDS_LIST = ["prisma", "db", "database", "orm", "tx", "trx"] as const

export type PrismaClientWord = (typeof PRISMA_CLIENT_WORDS_LIST)[number]

export const PRISMA_CLIENT_WORDS: ReadonlySet<PrismaClientWord> = new Set(PRISMA_CLIENT_WORDS_LIST)

export function namesPrismaClient(segment: string): boolean {
  return identifierMentions(segment, PRISMA_CLIENT_WORDS as ReadonlySet<string>)
}

export const PRISMA_DELEGATE_MAX_ARGUMENTS = 1
export const PRISMA_TRANSACTION_MAX_ARGUMENTS = 2

export function classificationConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
  maxArguments: number,
): Confidence {
  return receiverConfidence(clientSegment, call, maxArguments, namesPrismaClient)
}
