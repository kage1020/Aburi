import {
  call,
  component,
  fp,
  makeDiff,
  makeSymbol,
  movedChanged,
  rule,
  zeroFp,
} from "@aburi/test-support"
import type {
  Component,
  Dependency,
  Symbol as IRSymbol,
  SymbolChange,
  SymbolDelta,
  SymbolMovedChanged,
} from "@aburi/types"
import { type ProjectDiffOptions, projectComponent, projectDiff } from "../src"

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

/** The page of the `billing` Component unless `of` names another. */
export function componentPage(
  symbols: IRSymbol[],
  options: { dependencies?: Dependency[]; of?: Component } = {},
): string {
  return projectComponent({
    component: options.of ?? component({ id: "billing", name: "Billing" }),
    symbols,
    dependencies: options.dependencies ?? [],
  })
}

export function droppedSymbol(id: string, dropReason: string | null): IRSymbol {
  return makeSymbol({
    id,
    name: id.slice(id.indexOf("#") + 1),
    kind: "class",
    dropped: true,
    dropReason,
    fingerprint: zeroFp(),
  })
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

export function renamedPair(
  from: string,
  fromFile: string,
  to: string,
  toFile: string,
  flags: Partial<SymbolDelta> = { apiChanged: true, syntaxChanged: true },
): SymbolMovedChanged {
  return movedChanged(
    makeSymbol({ id: `ts:${fromFile}#${from}`, name: from }),
    makeSymbol({ id: `ts:${toFile}#${to}`, name: to }),
    flags,
    "logic-fingerprint",
  )
}
