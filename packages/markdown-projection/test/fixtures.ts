import { call, fp, makeSymbol, rule } from "@aburi/test-support"
import type {
  DiffResult,
  Symbol as IRSymbol,
  MatchRationale,
  Summary,
  SymbolChange,
  SymbolChanged,
  SymbolDelta,
  SymbolMoved,
  SymbolMovedChanged,
} from "@aburi/types"
import { type ProjectDiffOptions, projectDiff } from "../src"

/** Longer than a code span may be, so a rule carrying it fences. */
export const LONG_CONDITION =
  "user.role === 'admin' && flags.enabled && !session.expired && ctx.tenant === wantedTenantName"

export function emptySummary(): Summary {
  return {
    added: 0,
    removed: 0,
    moved: 0,
    movedChanged: 0,
    changed: 0,
    droppedToggled: 0,
    unchanged: 0,
    droppedAdded: 0,
    droppedRemoved: 0,
    componentsAdded: 0,
    componentsRemoved: 0,
    componentsChanged: 0,
    depsAdded: 0,
    depsRemoved: 0,
  }
}

export function makeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.diff.v1.json",
    generator: { name: "aburi", version: "0.0.0" },
    base: { ref: "main", irSchema: "aburi.ir.v1.json" },
    head: { ref: "HEAD", irSchema: "aburi.ir.v1.json" },
    summary: emptySummary(),
    symbols: [],
    components: { added: [], removed: [], changed: [] },
    dependencies: { added: [], removed: [] },
    slices: [],
    ...overrides,
  }
}

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

export function delta(overrides: Partial<SymbolDelta> = {}): SymbolDelta {
  return {
    apiChanged: false,
    logicChanged: false,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
    ...overrides,
  }
}

export function changed(
  before: IRSymbol,
  flags: Partial<SymbolDelta> = {},
  after: Partial<IRSymbol> = {},
): SymbolChanged {
  return { status: "changed", before, after: { ...before, ...after }, delta: delta(flags) }
}

export function movedChanged(
  before: IRSymbol,
  after: IRSymbol,
  flags: Partial<SymbolDelta> = {},
  rationale: MatchRationale = "git-rename",
): SymbolMovedChanged {
  return { status: "moved+changed", before, after, rationale, delta: delta(flags) }
}

export function moved(
  before: IRSymbol,
  after: IRSymbol,
  rationale: MatchRationale = "git-rename",
): SymbolMoved {
  return { status: "moved", before, after, rationale }
}
