import { createHash } from "node:crypto"
import { serializeCanonical } from "../canonical"

export const ZERO_FINGERPRINT = "000000000000" as const

export const FP_HEX_LENGTH = 12

export function hashCanonicalObject(value: unknown): string {
  const json = serializeCanonical(value, { format: "compact" })
  return hashRawString(json)
}

export function hashRawString(text: string): string {
  return sha256Hex(text).slice(0, FP_HEX_LENGTH)
}

/** Full lowercase-hex SHA-256 of `text`'s UTF-8 bytes; callers pick their own truncation. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}
