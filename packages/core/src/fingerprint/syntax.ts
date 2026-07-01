import { hashRawString } from "./hash"

/**
 * Compute the syntax axis from a language-plugin-provided normalized AST string.
 *
 * The normalized AST string is the language plugin's responsibility (its shape and
 * regularization rules live in each plugin's `normalizeAst()`). The plugin is contractually
 * required to satisfy:
 *   - no comment nodes
 *   - no position information (line / column / byte offset)
 *   - no whitespace tokens
 *   - node kinds and child structure only (S-expression style)
 *   - identifier and literal values included (structure + values, not structure only)
 *
 * All this function does is hash the resulting string. Callers that pass an empty string
 * still get a deterministic (but useless) hash — the plugin is expected to enforce non-
 * emptiness at extraction time.
 */
export function syntaxFingerprint(normalizedAstString: string): string {
  return hashRawString(normalizedAstString)
}
