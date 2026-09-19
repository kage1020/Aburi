import { toNfc } from "../codepoints"

/**
 * The fingerprint contract's "canonical string": Unicode NFC, every whitespace run collapsed
 * to one space, then trimmed, so a reflow or a stray trailing newline cannot move a hash.
 *
 * Limitation: the collapse is applied uniformly to every string field the fingerprint
 * consumes, so whitespace that is semantically significant inside a string literal —
 * embedded SQL, regex, or template text carried on `Decorator.raw` or `Rule.condition` —
 * is not distinguished from formatting whitespace. `@Query("SELECT a  b")` and
 * `@Query("SELECT a b")` hash identically. A follow-up axis that preserves in-literal
 * whitespace would require the language plugin to mark literal spans; we accept the
 * loss in exchange for reformat tolerance across the rest of the input.
 */
export function normalizeFingerprintString(input: string): string {
  return toNfc(input).replace(/\s+/g, " ").trim()
}
