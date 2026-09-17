import type { DiffResult, Summary } from "@aburi/types"

/** Diff-side builders; the IR builders come from `@aburi/test-support`. */

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
    summary: overrides.summary ?? emptySummary(),
    symbols: overrides.symbols ?? [],
    components: overrides.components ?? { added: [], removed: [], changed: [] },
    dependencies: overrides.dependencies ?? { added: [], removed: [] },
    slices: overrides.slices ?? [],
    ...overrides,
  }
}
