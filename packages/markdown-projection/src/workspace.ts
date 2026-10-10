import type { IR } from "@aburi/types"
import {
  appendAll,
  compareStrings,
  inlineCode,
  isSymbolEdge,
  renderDocument,
  sortDependencies,
  tableHeader,
  tableRow,
} from "./format"

/** Nodes above this render as text-only fallback so GitHub mermaid does not choke. */
export const MERMAID_NODE_LIMIT = 100

/** Top-N effect surface table. Kept at 10 to fit a PR-comment-safe height. */
export const EFFECT_SURFACE_TOP_N = 10

export interface ProjectWorkspaceOptions {
  /** Omit `generatedAt` even if the IR carries it (mirrors CLI `--no-timestamp`). */
  suppressTimestamp?: boolean
}

export function projectWorkspace(ir: IR, options: ProjectWorkspaceOptions = {}): string {
  const lines: string[] = []
  lines.push(`# Workspace`)
  lines.push("")
  lines.push(`**Languages**: ${[...ir.workspace.languages].sort().join(", ")}`)
  lines.push(`**Managers**: ${renderManagers(ir)}`)
  lines.push(`**Symbols**: ${renderSymbolCounts(ir)}`)
  if (!options.suppressTimestamp && ir.generatedAt !== undefined) {
    lines.push(`**Generated**: ${ir.generator.name} ${ir.generator.version} at ${ir.generatedAt}`)
  } else {
    lines.push(`**Generated**: ${ir.generator.name} ${ir.generator.version}`)
  }
  lines.push("")

  lines.push("## Components")
  lines.push("")
  appendAll(lines, renderComponentsTable(ir))
  lines.push("")

  lines.push("## Component dependencies")
  lines.push("")
  appendAll(lines, renderDependencies(ir))
  lines.push("")

  const skipped = renderSkippedFiles(ir)
  if (skipped.length > 0) {
    lines.push("## Files not analysed")
    lines.push("")
    appendAll(lines, skipped)
    lines.push("")
  }

  const effectSurface = renderEffectSurface(ir)
  if (effectSurface.length > 0) {
    lines.push(`## Effect surface (top ${EFFECT_SURFACE_TOP_N} by count)`)
    lines.push("")
    lines.push(...effectSurface)
    lines.push("")
  }

  return renderDocument(lines)
}

function renderSymbolCounts(ir: IR): string {
  const { keptSymbols, droppedSymbols, totalFiles, parsedFiles } = ir.stats
  const counts = `${keptSymbols} kept · ${droppedSymbols} dropped`
  if (parsedFiles >= totalFiles) return `${counts} (across ${totalFiles} files)`
  return `${counts} (across ${parsedFiles} of ${totalFiles} files; ${totalFiles - parsedFiles} produced no Symbols)`
}

function renderSkippedFiles(ir: IR): string[] {
  const skipped = ir.stats.skippedFiles ?? []
  if (skipped.length === 0) return []

  const byReason = new Map<string, string[]>()
  for (const file of skipped) {
    const paths = byReason.get(file.reason)
    if (paths === undefined) byReason.set(file.reason, [file.path])
    else paths.push(file.path)
  }

  const rows: string[] = [
    `${skipped.length} of ${ir.stats.totalFiles} file(s) produced no Symbols.`,
    "",
  ]
  for (const reason of [...byReason.keys()].sort(compareStrings)) {
    const paths = byReason.get(reason) ?? []
    rows.push(`- **${reason}** (${paths.length}):`)
    for (const path of paths) rows.push(`  - ${inlineCode(path)}`)
  }
  return rows
}

function renderManagers(ir: IR): string {
  if (ir.workspace.managers.length === 0) return "—"
  return [...ir.workspace.managers]
    .sort((a, b) => compareStrings(a.tool, b.tool))
    .map((m) => `${m.tool} (${m.roots.map((root) => inlineCode(root)).join(", ")})`)
    .join(", ")
}

function renderComponentsTable(ir: IR): string[] {
  if (ir.components.length === 0) {
    return ["_No components defined._"]
  }
  const rows: string[] = [...tableHeader(["id", "roots", "languages", "frameworks", "symbols"])]
  const symbolCountsByComponent = countSymbolsPerComponent(ir)
  for (const c of [...ir.components].sort((a, b) => compareStrings(a.id, b.id))) {
    const roots = c.roots.map((root) => inlineCode(root)).join(", ")
    const languages = c.languages.join(", ")
    const frameworks = (c.frameworks ?? []).length > 0 ? (c.frameworks ?? []).join(", ") : "—"
    const symbolCount = symbolCountsByComponent.get(c.id) ?? 0
    rows.push(tableRow([c.id, roots, languages, frameworks, String(symbolCount)]))
  }
  return rows
}

function countSymbolsPerComponent(ir: IR): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of ir.symbols) {
    if (s.component === null || s.component === undefined) continue
    if (s.dropped) continue
    counts.set(s.component, (counts.get(s.component) ?? 0) + 1)
  }
  return counts
}

function renderDependencies(ir: IR): string[] {
  const componentDeps = ir.dependencies.filter((d) => !isSymbolEdge(d))
  const sortedComponents = [...ir.components].sort((a, b) => compareStrings(a.id, b.id))
  const edgeNodes = new Set<string>()
  for (const d of componentDeps) {
    edgeNodes.add(d.from)
    edgeNodes.add(d.to)
  }
  const unionNodeCount = new Set<string>([...sortedComponents.map((c) => c.id), ...edgeNodes]).size
  if (unionNodeCount === 0) return ["_No inter-component dependencies._"]

  const rows: string[] = []
  if (unionNodeCount <= MERMAID_NODE_LIMIT) {
    rows.push("```mermaid")
    rows.push("graph LR")
    for (const c of sortedComponents) {
      rows.push(`  ${sanitizeMermaidId(c.id)}["${escapeMermaidLabel(c.name)}"]`)
    }
    const seenEdge = new Set<string>()
    for (const d of sortDependencies(componentDeps)) {
      const key = `${d.from}->${d.to}`
      if (seenEdge.has(key)) continue
      seenEdge.add(key)
      rows.push(`  ${sanitizeMermaidId(d.from)} --> ${sanitizeMermaidId(d.to)}`)
    }
    rows.push("```")
  } else {
    rows.push(
      `_Component graph omitted: ${unionNodeCount} nodes exceeds the render limit (${MERMAID_NODE_LIMIT}). See list below._`,
    )
  }
  if (componentDeps.length > 0) {
    rows.push("")
    rows.push("Fallback list:")
    rows.push("")
    for (const d of sortDependencies(componentDeps)) {
      rows.push(`- ${d.from} → ${d.to} (via ${inlineCode(d.via)})`)
    }
  }
  return rows
}

function sanitizeMermaidId(id: string): string {
  return id.replace(/-/g, "_")
}

function escapeMermaidLabel(label: string): string {
  return label
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\]/g, "&rbrack;")
    .replace(/\r?\n/g, "<br/>")
}

function renderEffectSurface(ir: IR): string[] {
  interface Row {
    effect: string
    count: number
    components: Set<string>
  }
  const rowsByEffect = new Map<string, Row>()
  for (const s of ir.symbols) {
    if (s.dropped) continue
    for (const e of s.effects) {
      const row = rowsByEffect.get(e.id) ?? { effect: e.id, count: 0, components: new Set() }
      row.count++
      if (s.component !== null && s.component !== undefined) row.components.add(s.component)
      rowsByEffect.set(e.id, row)
    }
  }
  if (rowsByEffect.size === 0) return []
  const sorted = [...rowsByEffect.values()].sort(
    (a, b) => b.count - a.count || compareStrings(a.effect, b.effect),
  )
  const top = sorted.slice(0, EFFECT_SURFACE_TOP_N)
  const out: string[] = [...tableHeader(["effect", "count", "components"])]
  for (const r of top) {
    const components = r.components.size === 0 ? "—" : [...r.components].sort().join(", ")
    out.push(tableRow([r.effect, String(r.count), components]))
  }
  return out
}
