import type { IR } from "@aburi/types"
import {
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

/**
 * markdown-projection.md — `workspace.md`: monorepo shape (managers, languages, symbol
 * counts), a Components table, dependencies (mermaid + text fallback), and the top-10 effect
 * surface.
 */
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
  lines.push(...renderComponentsTable(ir))
  lines.push("")

  lines.push("## Component dependencies")
  lines.push("")
  lines.push(...renderDependencies(ir))
  lines.push("")

  const skipped = renderSkippedFiles(ir)
  if (skipped.length > 0) {
    lines.push("## Files not analysed")
    lines.push("")
    lines.push(...skipped)
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

/**
 * The header line, which has to leave three states apart rather than two.
 *
 * `across N files` alone reads as "all N were analysed", a claim the document is in no
 * position to make whenever `parsedFiles` is lower, so that case takes the second wording.
 * The third state shares that wording and is told apart below it: a document written before
 * `stats.skippedFiles` existed knows files were lost but cannot name them, so
 * `renderSkippedFiles` emits nothing and the header stands alone — where a document that can
 * name them is followed by the list. `aburi diff` warns on stderr in that third state; a pure
 * projection has no stderr, so the distinction has to be in the bytes.
 */
function renderSymbolCounts(ir: IR): string {
  const { keptSymbols, droppedSymbols, totalFiles, parsedFiles } = ir.stats
  const counts = `${keptSymbols} kept · ${droppedSymbols} dropped`
  if (parsedFiles >= totalFiles) return `${counts} (across ${totalFiles} files)`
  return `${counts} (across ${parsedFiles} of ${totalFiles} files; ${totalFiles - parsedFiles} produced no Symbols)`
}

/**
 * The files the scan gave up on, grouped by why, counts first. Omitted rather than rendered
 * empty for a document written before `stats.skippedFiles` existed: "this run lost nothing"
 * and "this writer could not say" are different answers.
 */
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

/**
 * Mermaid `graph LR` of the workspace: every declared component is a node — isolated ones
 * with no incident edge included, which markdown-projection.md states outright — component →
 * component dependencies are edges, and a text fallback list follows when any edge exists.
 * Above `MERMAID_NODE_LIMIT` the mermaid block is dropped and only the list survives.
 *
 * Symbol-to-symbol call edges are excluded: they would blow past the render limit and drown
 * the L0 overview in method-granularity detail. Assumes ir-schema.md invariant #2 (unique
 * `Component.id`); the projection trusts `assertIRIntegrity` upstream and does not re-check.
 */
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
    // Isolated components only ever surface inside the mermaid block, so this note is also
    // the only signal that they exist above the cap.
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

/**
 * Mermaid ids reject `-`, so it becomes `_`. `ComponentId` is kebab-case with no `_`, so the
 * mapping is injective — the injectivity test breaks first if the schema ever admits `_`.
 */
function sanitizeMermaidId(id: string): string {
  return id.replace(/-/g, "_")
}

/**
 * `Component.name` is arbitrary user text inside the label syntax `id["label"]`, where `"`,
 * `]`, `<` / `>` and a newline each break the render. Mermaid accepts HTML entities inside
 * labels; `\n` maps to its native `<br/>`.
 */
function escapeMermaidLabel(label: string): string {
  return label
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\]/g, "&rbrack;")
    .replace(/\r?\n/g, "<br/>")
}

/**
 * Effect surface top-N table, ties broken by effect id. The component column
 * deduplicates the origin list.
 */
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
