import { call, fp, makeDiff, makeSymbol, rule } from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"
import { type ProjectDiffOptions, projectDiff } from "../src"

/** Longer than a code span may be, so a rule carrying it fences. */
export const LONG_CONDITION =
  "user.role === 'admin' && flags.enabled && !session.expired && ctx.tenant === wantedTenantName"

/** `diff.md` for these changes alone; the Summary line reads all zeros. */
export function projectChanges(
  changes: readonly SymbolChange[],
  options?: ProjectDiffOptions,
): string {
  return projectDiff(makeDiff({ symbols: [...changes] }), options)
}

export function namedSymbol(
  name: string,
  overrides: Omit<Parameters<typeof makeSymbol>[0], "id" | "name"> = {},
): IRSymbol {
  return makeSymbol({ id: `ts:src/${name}.ts#${name}`, name, fingerprint: fp(name), ...overrides })
}

/** A Symbol with a rule and a call, so its full entry outweighs its names-only row. */
export function symbolWithBody(name: string): IRSymbol {
  return namedSymbol(name, {
    rules: [rule({ type: "guard", condition: "input !== null", line: 3 })],
    calls: [call({ target: "logger.info", line: 4 })],
  })
}

export function relocated(symbol: IRSymbol, file: string): IRSymbol {
  return { ...symbol, source: { ...symbol.source, file } }
}
