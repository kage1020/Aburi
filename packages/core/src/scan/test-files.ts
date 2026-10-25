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
  const patterns = config.testFiles ?? DEFAULT_TEST_FILES
  if (patterns.length === 0) return [...symbols]
  // `dot` as the walk that applies `ignore` has it, and NFC as the IR spells every path.
  const matches = picomatch(patterns.map(toNfc), { dot: true })
  const verdicts = new Map<string, boolean>()
  return symbols.map((symbol) => {
    const { file } = symbol.source
    let inTestFile = verdicts.get(file)
    if (inTestFile === undefined) {
      inTestFile = matches(file)
      verdicts.set(file, inTestFile)
    }
    return inTestFile ? { ...symbol, inTestFile: true } : symbol
  })
}
