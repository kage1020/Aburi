import { posix } from "node:path"
import type { Config, Symbol as IRSymbol } from "@aburi/types"
import picomatch from "picomatch"
import { toNfc } from "../codepoints"

export const DEFAULT_TEST_FILES: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.test-d.*",
  "**/*.spec-d.*",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/__fixtures__/**",
  "**/test/**",
  "**/tests/**",
  "**/e2e/**",
]

export function markTestFiles(
  symbols: readonly IRSymbol[],
  config: Pick<Config, "testFiles">,
): IRSymbol[] {
  const isTestFile = testFileMatcher(config.testFiles ?? DEFAULT_TEST_FILES)
  if (isTestFile === null) return [...symbols]
  const verdicts = new Map<string, boolean>()
  return symbols.map((symbol) => {
    const { file } = symbol.source
    let inTestFile = verdicts.get(file)
    if (inTestFile === undefined) {
      inTestFile = isTestFile(file)
      verdicts.set(file, inTestFile)
    }
    return inTestFile ? { ...symbol, inTestFile: true } : symbol
  })
}

/**
 * The walk skips a `!` entry of `ignore`. Here one carves files out of the others instead, as
 * picomatch would otherwise read `!src/test/**` alone as every other file in the workspace.
 */
function testFileMatcher(patterns: readonly string[]): ((file: string) => boolean) | null {
  const included: string[] = []
  const excluded: string[] = []
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!") && !pattern.startsWith("!(")
    if (negated) excluded.push(asTheWalkReads(pattern.slice(1)))
    else included.push(asTheWalkReads(pattern))
  }
  if (included.length === 0) return null
  const options = { dot: true, posix: true }
  const isIncluded = picomatch(included, options)
  if (excluded.length === 0) return isIncluded
  const isExcluded = picomatch(excluded, options)
  return (file) => isIncluded(file) && !isExcluded(file)
}

/** The walk reads an `ignore` entry that does not end in `*` as a directory too; the IR spells every path in NFC. */
function asTheWalkReads(pattern: string): string {
  return posix.normalize(toNfc(pattern.endsWith("*") ? pattern : `${pattern}/**`))
}
