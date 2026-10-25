import type { Dependency, DependencyUnknown, DiffResult } from "@aburi/types"
import { inlineCode, isSymbolEdge, symbolIdParts } from "../format"

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

/** A Symbol id repeats its language on every end, and an edge inside one file writes the path twice. */
function edge(d: Dependency): string {
  const from = symbolIdParts(d.from)
  const to = symbolIdParts(d.to)
  const via = ` (via ${inlineCode(d.via)})`
  if (from !== null && to !== null && from.file === to.file) {
    return `${inlineCode(from.name)} → ${inlineCode(to.name)} in ${inlineCode(from.file)}${via}`
  }
  return `${endpoint(d.from)} → ${endpoint(d.to)}${via}`
}

function endpoint(id: Dependency["from"]): string {
  const parts = symbolIdParts(id)
  return parts === null ? inlineCode(id) : `${inlineCode(parts.name)} in ${inlineCode(parts.file)}`
}
