/**
 * Normalize a string for fingerprint input.
 *
 * The three steps are the fingerprint contract's "canonical string" rule:
 *   1. Unicode NFC — so `café` (composed) and `café` (decomposed) hash the same.
 *   2. Collapse any run of whitespace (space / tab / CR / LF) into a single space —
 *      so a reflow that turns `x + y` into `x+\ny` cannot change the api or logic
 *      fingerprint.
 *   3. Trim leading and trailing whitespace — so a stray `\n` at the end of a decorator
 *      raw string does not perturb the hash.
 *
 * Empty strings stay empty. Non-string values are the caller's responsibility (this is a
 * string-level helper, not a JSON value coercer).
 *
 * Limitation: this collapse is applied uniformly to every string field the fingerprint
 * consumes, so whitespace that is semantically significant inside a string literal —
 * embedded SQL, regex, or template text carried on `Decorator.raw` or `Rule.condition` —
 * is not distinguished from formatting whitespace. `@Query("SELECT a  b")` and
 * `@Query("SELECT a b")` hash identically. A follow-up axis that preserves in-literal
 * whitespace would require the language plugin to mark literal spans; we accept the
 * loss in exchange for reformat tolerance across the rest of the input.
 */
export function normalizeFingerprintString(input: string): string {
  return input.normalize("NFC").replace(/\s+/g, " ").trim()
}
