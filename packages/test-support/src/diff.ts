import type {
  DiffResult,
  Symbol as IRSymbol,
  MatchRationale,
  Summary,
  SymbolChanged,
  SymbolDelta,
  SymbolMoved,
  SymbolMovedChanged,
} from "@aburi/types"

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

/** A diff of `main` against `HEAD` that reports nothing, with `overrides` laid over it. */
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

/** A delta with every axis unmoved except those `flags` set. */
export function delta(flags: Partial<SymbolDelta> = {}): SymbolDelta {
  return {
    apiChanged: false,
    logicChanged: false,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
    ...flags,
  }
}

/** `before` changed in place: `after` is `before` with `after`'s fields laid over it. */
export function changed(
  before: IRSymbol,
  flags: Partial<SymbolDelta> = {},
  after: Partial<IRSymbol> = {},
): SymbolChanged {
  return { status: "changed", before, after: { ...before, ...after }, delta: delta(flags) }
}

export function moved(
  before: IRSymbol,
  after: IRSymbol,
  rationale: MatchRationale = "git-rename",
): SymbolMoved {
  return { status: "moved", before, after, rationale }
}

export function movedChanged(
  before: IRSymbol,
  after: IRSymbol,
  flags: Partial<SymbolDelta> = {},
  rationale: MatchRationale = "git-rename",
): SymbolMovedChanged {
  return { status: "moved+changed", before, after, rationale, delta: delta(flags) }
}
