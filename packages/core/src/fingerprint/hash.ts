import { createHash } from "node:crypto"
import { serializeCanonical } from "../canonical"

/**
 * Fingerprint value assigned to every axis of a dropped Symbol so cross-IR comparisons
 * report "no change" without needing a special-case elsewhere.
 */
export const ZERO_FINGERPRINT = "000000000000" as const

/**
 * Fingerprint width in hex characters. 48 bits (12 hex chars) keeps monorepo-scale
 * collisions negligible (2^48 ≈ 2.8×10^14) while staying short enough to eyeball in
 * diff reports.
 */
const FP_HEX_LENGTH = 12

/**
 * Serialize an object with the canonical rules (NFC strings, code-unit-sorted keys,
 * compact form, no whitespace) then hash the UTF-8 bytes with SHA-256 and return the
 * first 6 bytes as lowercase hex. This is the shared calculation path for the api and
 * logic axes; `syntax` calls hashRawString directly because the language plugin owns
 * its normalized AST string form.
 */
export function hashCanonicalObject(value: unknown): string {
  const json = serializeCanonical(value, { format: "compact" })
  return hashRawString(json)
}

/**
 * Hash a pre-formed UTF-8 string. `syntax` axis: the language plugin emits an already-
 * normalized AST S-expression (positions stripped, comments removed) and we only need
 * the SHA-256 → 12 hex truncation here.
 */
export function hashRawString(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, FP_HEX_LENGTH)
}
