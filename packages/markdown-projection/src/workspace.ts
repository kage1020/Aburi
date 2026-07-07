import type { IR } from "@aburi/types"
import { compareStrings } from "./format"

/** §4.2 — nodes above this render as text-only fallback so GitHub mermaid does not choke. */
export const MERMAID_NODE_LIMIT = 100

/** §4.1 — top-N effect surface table. Kept at 10 to fit a PR-comment-safe height. */
export const EFFECT_SURFACE_TOP_N = 10

export interface ProjectWorkspaceOptions {
  /** §4.3 — omit `generatedAt` even if the IR carries it (mirrors CLI `--no-timestamp`). */
  suppressTimestamp?: boolean
}

/**
 * §4 — `workspace.md`. Aggregates monorepo shape (managers, languages, symbol counts),
 * a Components table, dependencies (mermaid + text fallback), and the top-10 effect
 * surface. Deterministic: same IR always produces the same string.
 */
export function projectWorkspace(ir: IR, options: ProjectWorkspaceOptions = {}): string {
  const lines: string[] = []
  lines.push(`# Workspace`)
  lines.push("")
  lines.push(`**Languages**: ${[...ir.workspace.languages].sort().join(", ")}`)
  lines.push(`**Managers**: ${renderManagers(ir)}`)
  lines.push(
    `**Symbols**: ${ir.stats.keptSymbols} kept · ${ir.stats.droppedSymbols} dropped (across ${ir.stats.totalFiles} files)`,
  )
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

  const effectSurface = renderEffectSurface(ir)
  if (effectSurface.length > 0) {
    lines.push(`## Effect surface (top ${EFFECT_SURFACE_TOP_N} by count)`)
    lines.push("")
    lines.push(...effectSurface)
    lines.push("")
  }

  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  )
}

function renderManagers(ir: IR): string {
  if (ir.workspace.managers.length === 0) return "—"
  return ir.workspace.managers
    .slice()
    .sort((a, b) => compareStrings(a.tool, b.tool))
    .map((m) => `${m.tool} (${m.roots.map((r) => `\`${r}\``).join(", ")})`)
    .join(", ")
}

function renderComponentsTable(ir: IR): string[] {
  if (ir.components.length === 0) {
    return ["_No components defined._"]
  }
  const rows: string[] = []
  rows.push("| id | roots | languages | frameworks | symbols |")
  rows.push("|---|---|---|---|---|")
  const symbolCountsByComponent = countSymbolsPerComponent(ir)
  for (const c of [...ir.components].sort((a, b) => compareStrings(a.id, b.id))) {
    const roots = c.roots.map((r) => `\`${r}\``).join(", ")
    const languages = c.languages.join(", ")
    const frameworks = (c.frameworks ?? []).length > 0 ? (c.frameworks ?? []).join(", ") : "—"
    const symbolCount = symbolCountsByComponent.get(c.id) ?? 0
    rows.push(`| ${c.id} | ${roots} | ${languages} | ${frameworks} | ${symbolCount} |`)
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
 * §4.2 — mermaid graph LR with a text-fallback block always attached. When there are no
 * dependencies at all, only a short note is emitted; when the node count exceeds
 * `MERMAID_NODE_LIMIT`, the mermaid block is dropped and only the text list survives.
 */
function renderDependencies(ir: IR): string[] {
  if (ir.dependencies.length === 0) return ["_No inter-component dependencies._"]
  const nodeSet = new Set<string>()
  for (const d of ir.dependencies) {
    nodeSet.add(d.from)
    nodeSet.add(d.to)
  }
  const rows: string[] = []
  if (nodeSet.size <= MERMAID_NODE_LIMIT) {
    rows.push("```mermaid")
    rows.push("graph LR")
    const seen = new Set<string>()
    for (const d of sortedDeps(ir)) {
      const key = `${d.from}->${d.to}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(`  ${sanitizeMermaidId(d.from)} --> ${sanitizeMermaidId(d.to)}`)
    }
    rows.push("```")
    rows.push("")
    rows.push("Fallback list:")
    rows.push("")
  }
  for (const d of sortedDeps(ir)) {
    rows.push(`- ${d.from} → ${d.to} (via \`${d.via}\`)`)
  }
  return rows
}

function sortedDeps(ir: IR): typeof ir.dependencies {
  return [...ir.dependencies].sort((a, b) => {
    if (a.from !== b.from) return compareStrings(a.from, b.from)
    if (a.to !== b.to) return compareStrings(a.to, b.to)
    return compareStrings(a.via, b.via)
  })
}

/**
 * Mermaid ids reject `-` at the graph level so we swap in `_`. Component ids come from
 * `ir-schema §11` which allows only ASCII kebab-case, and no other characters need
 * escaping.
 */
function sanitizeMermaidId(id: string): string {
  return id.replace(/-/g, "_")
}

/**
 * §4.1 — Effect surface top-N table. Ties are broken by `effect id` asciibetically so
 * the row order is deterministic. When two symbols share an effect id, the *component*
 * column deduplicates the origin list.
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
  const sorted = [...rowsByEffect.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count
    return compareStrings(a.effect, b.effect)
  })
  const top = sorted.slice(0, EFFECT_SURFACE_TOP_N)
  const out: string[] = ["| effect | count | components |", "|---|---|---|"]
  for (const r of top) {
    const comps = r.components.size === 0 ? "—" : [...r.components].sort().join(", ")
    out.push(`| ${r.effect} | ${r.count} | ${comps} |`)
  }
  return out
}
