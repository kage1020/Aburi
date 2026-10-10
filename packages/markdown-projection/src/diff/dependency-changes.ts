import type { Dependency, DependencyUnknown, DiffResult } from "@aburi/types"
import { inlineCode, isSymbolEdge } from "../format"

export function renderDependencyChanges(diff: DiffResult): string[] {
  const { added, removed } = diff.dependencies
  const rows: string[] = []
  appendDependencyGroup(
    rows,
    "Component-level added",
    added.filter((d) => !isSymbolEdge(d)),
  )
  appendDependencyGroup(
    rows,
    "Component-level removed",
    removed.filter((d) => !isSymbolEdge(d)),
  )
  appendDependencyGroup(rows, "Symbol-level added", added.filter(isSymbolEdge))
  appendDependencyGroup(rows, "Symbol-level removed", removed.filter(isSymbolEdge))
  appendUnknownDependencies(rows, diff.dependencies.unknown ?? [])
  return rows
}

function appendDependencyGroup(rows: string[], heading: string, deps: readonly Dependency[]): void {
  if (deps.length === 0) return
  rows.push(`### ${heading}`)
  for (const d of deps) rows.push(`- ${edge(d)}`)
  rows.push("")
}

function appendUnknownDependencies(rows: string[], unknown: readonly DependencyUnknown[]): void {
  if (unknown.length === 0) return
  rows.push("### Unknown — the other revision never read one end")
  for (const entry of unknown) {
    const lost = entry.lostFiles.map((f) => `${inlineCode(f.path)} (${f.reason})`).join(", ")
    rows.push(`- ${edge(entry.dependency)} — the ${entry.absentFrom} scan skipped ${lost}`)
  }
  rows.push("")
}

function edge(d: Dependency): string {
  return `${inlineCode(d.from)} → ${inlineCode(d.to)} (via ${inlineCode(d.via)})`
}
