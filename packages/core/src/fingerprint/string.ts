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
 */
export function normalizeFingerprintString(input: string): string {
  return input.normalize("NFC").replace(/\s+/g, " ").trim()
}
