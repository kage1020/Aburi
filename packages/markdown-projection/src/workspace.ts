import type { Dependency, IR } from "@aburi/types"
import { compareStrings, isSymbolIdEndpoint } from "./format"

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

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`
}

/**
 * The header line, which has to distinguish three states rather than two.
 *
 * `across N files` alone reads as "all N were analysed", which is a claim the document is in
 * no position to make whenever `parsedFiles` is lower. The section below names the files when
 * the document can, but a document written before `stats.skippedFiles` existed cannot — and
 * that is precisely the case where the header would otherwise render byte-identically to a
 * clean scan. `aburi diff` warns on stderr in that state; a pure projection has no stderr, so
 * the distinction has to be in the bytes.
 */
function renderSymbolCounts(ir: IR): string {
  const { keptSymbols, droppedSymbols, totalFiles, parsedFiles } = ir.stats
  const counts = `${keptSymbols} kept · ${droppedSymbols} dropped`
  if (parsedFiles >= totalFiles) return `${counts} (across ${totalFiles} files)`
  return `${counts} (across ${parsedFiles} of ${totalFiles} files; ${totalFiles - parsedFiles} produced no Symbols)`
}

/**
 * The files the scan gave up on, grouped by why.
 *
 * A reader holding only `workspace.md` otherwise sees `keptSymbols … across N files` and no
 * hint that some of those N produced nothing — and every consumer downstream, `aburi diff`
 * included, would read the absence of a Symbol as a deletion. The counts come first because
 * the shape (one file, or all of them) is the thing to notice, and the paths follow so the
 * reader can go and look.
 *
 * Absent from documents written before `stats.skippedFiles` existed, and the section is then
 * omitted rather than rendered empty: "this run lost nothing" and "this writer could not say"
 * are different answers. The header line above keeps the second from reading as the first.
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
    for (const path of paths) rows.push(`  - \`${path}\``)
  }
  return rows
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
 * §4.2 — mermaid graph LR of the workspace: every declared component is a node,
 * component→component dependencies are edges. A text-fallback bullet list is
 * appended when at least one edge exists. When the union of declared components
 * and edge endpoints exceeds `MERMAID_NODE_LIMIT`, the mermaid block is dropped
 * and only the text list survives.
 *
 * Symbol-to-symbol call edges are deliberately excluded from the workspace-level
 * mermaid graph. A monorepo with many resolved calls would explode the node count
 * past the mermaid render limit and drown the L0 overview in method-granularity
 * detail. Symbol edges surface in the per-Symbol explain view and the diff view;
 * this section stays component-scoped so the workspace overview keeps its
 * architectural altitude.
 *
 * Isolated components (declared in `ir.components` but touched by no dependency)
 * still render as standalone mermaid nodes so the L0 overview matches the "full
 * monorepo view" contract of `docs/design/overview.md` §3.1.
 *
 * Assumes `ir-schema §14` invariant #2 (`Component.id` uniqueness across
 * `ir.components`). Under that invariant the node-declaration loop is
 * duplicate-free; a violation is a scan-side integrity bug and would silently
 * overwrite one label with another, so `assertIRIntegrity` upstream is the
 * intended gatekeeper — the projection layer trusts it and does not re-check.
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
    for (const d of sortedDeps(componentDeps)) {
      const key = `${d.from}->${d.to}`
      if (seenEdge.has(key)) continue
      seenEdge.add(key)
      rows.push(`  ${sanitizeMermaidId(d.from)} --> ${sanitizeMermaidId(d.to)}`)
    }
    rows.push("```")
  } else {
    // Explicit note so readers understand the diagram vanished on purpose (the
    // 100-node cap was tripped) rather than blaming a broken renderer. Isolated
    // components only ever surface inside the mermaid block, so this note is
    // also the only signal that they exist above the cap.
    rows.push(
      `_Component graph omitted: ${unionNodeCount} nodes exceeds the render limit (${MERMAID_NODE_LIMIT}). See list below._`,
    )
  }
  if (componentDeps.length > 0) {
    rows.push("")
    rows.push("Fallback list:")
    rows.push("")
    for (const d of sortedDeps(componentDeps)) {
      rows.push(`- ${d.from} → ${d.to} (via \`${d.via}\`)`)
    }
  }
  return rows
}

function sortedDeps(deps: readonly Dependency[]): Dependency[] {
  return [...deps].sort((a, b) => {
    if (a.from !== b.from) return compareStrings(a.from, b.from)
    if (a.to !== b.to) return compareStrings(a.to, b.to)
    return compareStrings(a.via, b.via)
  })
}

function isSymbolEdge(d: Dependency): boolean {
  return isSymbolIdEndpoint(d.from) || isSymbolIdEndpoint(d.to)
}

/**
 * Mermaid ids reject `-` at the graph level so we swap in `_`. `ComponentId` is
 * kebab-case with no `_`, so the mapping is total and injective — the injectivity
 * tripwire test breaks first if the schema ever admits `_` in ComponentId.
 */
function sanitizeMermaidId(id: string): string {
  return id.replace(/-/g, "_")
}

/**
 * `Component.name` is arbitrary user text that lands inside the mermaid label syntax
 * `id["label"]`. Several characters would silently break the graph render:
 *   `"` closes the label prematurely
 *   `]` closes the node early
 *   `<` / `>` break out into raw HTML mode
 *   `\n` splits the mermaid statement in two
 * Mermaid accepts HTML entities inside labels, so the escape is safe and reversible
 * for reviewers scanning the rendered graph; `\n` maps to `<br/>` (mermaid's native
 * line-break inside a label).
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
