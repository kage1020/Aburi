import {
  type Dependency,
  type DependencyEndpoint,
  type DiffResult,
  representativeSymbol,
  type SymbolChange,
} from "@aburi/types"
import { counted } from "../format"
import { dependencyRow } from "./dependency-changes"
import {
  indexChanged,
  indexConfidence,
  indexDroppedToggled,
  indexMoved,
  indexRemoved,
  indexSymbols,
  indexUnknown,
} from "./names-only"
import { type ChangedEntry, partition } from "./partition"

export function inTestFile(change: SymbolChange): boolean {
  return representativeSymbol(change).inTestFile === true
}

export interface TestDependencies {
  readonly added: readonly Dependency[]
  readonly removed: readonly Dependency[]
}

/**
 * An edge carries no mark, but a call edge that comes or goes moves its caller's calls, so the
 * caller is one of the changes the fold lists, and the edge goes with it: into the fold when the
 * caller is among `listedTestChanges`, and out of the report when a status filter left it out.
 */
export function splitDependencies(
  dependencies: DiffResult["dependencies"],
  testChanges: readonly SymbolChange[],
  listedTestChanges: readonly SymbolChange[] = testChanges,
): { kept: DiffResult["dependencies"]; inTests: TestDependencies } {
  const fromTest = calledFrom(testChanges)
  const fromListed = calledFrom(listedTestChanges)
  return {
    kept: {
      ...dependencies,
      added: dependencies.added.filter((d) => !fromTest(d)),
      removed: dependencies.removed.filter((d) => !fromTest(d)),
    },
    inTests: {
      added: dependencies.added.filter(fromListed),
      removed: dependencies.removed.filter(fromListed),
    },
  }
}

function calledFrom(changes: readonly SymbolChange[]): (dependency: Dependency) => boolean {
  const callers = new Set<DependencyEndpoint>()
  for (const change of changes) {
    callers.add(representativeSymbol(change).id)
    if ("before" in change) callers.add(change.before.id)
  }
  return (dependency) => callers.has(dependency.from)
}

export function renderTestFiles(
  changes: readonly SymbolChange[],
  dependencies: TestDependencies,
): string[] {
  const buckets = partition(changes)
  // Moved + Changed lists a moved pair whole, so the delta groups take only what stayed put.
  const stayed = (items: readonly ChangedEntry[]) =>
    items.filter((item) => item.status === "changed")
  const groups: ReadonlyArray<readonly [readonly [string, string], readonly string[]]> = [
    [["API change", "API changes"], indexChanged(stayed(buckets.apiChanged))],
    [["logic change", "logic changes"], indexChanged(stayed(buckets.logicOnly))],
    [["added", "added"], indexSymbols(buckets.added)],
    [["removed", "removed"], indexRemoved(buckets.removed)],
    [["unknown", "unknown"], indexUnknown(buckets.unknown)],
    [["moved + changed", "moved + changed"], indexMoved(buckets.movedChanged)],
    [["moved", "moved"], indexMoved(buckets.moved)],
    [["dependency added", "dependencies added"], dependencies.added.map(dependencyRow)],
    [["dependency removed", "dependencies removed"], dependencies.removed.map(dependencyRow)],
    [["dropped change", "dropped changes"], indexDroppedToggled(buckets.droppedToggled)],
    [["confidence change", "confidence changes"], indexConfidence(stayed(buckets.confidenceOnly))],
    [["syntax-only change", "syntax-only changes"], indexChanged(stayed(buckets.syntaxOnly))],
  ]
  return groups
    .filter(([, rows]) => rows.length > 0)
    .flatMap(([[one, many], rows], index) => [
      ...(index === 0 ? [] : [""]),
      `**${counted(rows.length, one, many)}**`,
      ...rows,
    ])
}
