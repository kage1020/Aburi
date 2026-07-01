import { CoreError } from "../errors"
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
 * Refuses empty / whitespace-only input so a broken plugin cannot silently collapse every
 * missing-AST Symbol to the same SHA-256-of-nothing hash. The caller (computeSymbolFingerprint)
 * already enforces that dropped Symbols skip this path; this is the second guard.
 */
export function syntaxFingerprint(normalizedAstString: string): string {
  if (normalizedAstString.trim().length === 0) {
    throw new CoreError(
      "syntaxFingerprint received an empty normalized AST string; every missing-AST Symbol would otherwise collapse to the same hash",
      { code: "non-plain-json", value: "" },
    )
  }
  return hashRawString(normalizedAstString)
}
