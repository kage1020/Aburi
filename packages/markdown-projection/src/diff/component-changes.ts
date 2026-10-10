import type { Component, DiffResult } from "@aburi/types"
import { compareStrings, inlineCode } from "../format"

export function renderComponentChanges(diff: DiffResult): string[] {
  const rows: string[] = []
  if (diff.components.added.length > 0) {
    rows.push("### Added")
    for (const c of [...diff.components.added].sort((a, b) => compareStrings(a.id, b.id))) {
      rows.push(`- ${inlineCode(c.id)} — roots: ${c.roots.map((r) => inlineCode(r)).join(", ")}`)
    }
    rows.push("")
  }
  if (diff.components.removed.length > 0) {
    rows.push("### Removed")
    for (const c of [...diff.components.removed].sort((a, b) => compareStrings(a.id, b.id))) {
      rows.push(`- ${inlineCode(c.id)}`)
    }
    rows.push("")
  }
  if (diff.components.changed.length > 0) {
    rows.push("### Changed")
    for (const ch of diff.components.changed) {
      const fields = changedComponentFields(ch.before, ch.after)
      rows.push(
        fields.length === 0
          ? `- ${inlineCode(ch.after.id)}`
          : `- ${inlineCode(ch.after.id)}: ${fields.join(", ")}`,
      )
    }
    rows.push("")
  }
  return rows
}

function changedComponentFields(before: Component, after: Component): string[] {
  const fields: string[] = []
  if (before.name !== after.name) {
    fields.push(`name (${inlineCode(before.name)} → ${inlineCode(after.name)})`)
  }
  if (!sameList(before.roots, after.roots)) fields.push("roots")
  if (!sameList(before.publicApi ?? [], after.publicApi ?? [])) fields.push("publicApi")
  if (!sameList(before.languages, after.languages)) fields.push("languages")
  if (!sameList(before.frameworks ?? [], after.frameworks ?? [])) fields.push("frameworks")
  const beforeDescription = before.description ?? null
  const afterDescription = after.description ?? null
  if (beforeDescription !== afterDescription) {
    fields.push(
      `description (${renderDescription(beforeDescription)} → ${renderDescription(afterDescription)})`,
    )
  }
  fields.push(...unknownChangedFields(before, after))
  return fields
}

function unknownChangedFields(before: Component, after: Component): string[] {
  // Widened through `unknown`: the keys being read are by definition not on `Component`.
  const beforeRecord = before as unknown as Record<string, unknown>
  const afterRecord = after as unknown as Record<string, unknown>
  const names = new Set<string>()
  for (const key of [...Object.keys(beforeRecord), ...Object.keys(afterRecord)]) {
    if (key === "id" || RENDERED_COMPONENT_FIELDS.has(key)) continue
    if (normalizeUnknown(beforeRecord[key]) !== normalizeUnknown(afterRecord[key])) names.add(key)
  }
  return [...names].sort(compareStrings)
}

/** Absence, `null` and `[]` all read as "no value", matching the diff layer's normalization. */
function normalizeUnknown(value: unknown): string {
  // `absent` unquoted is unreachable as JSON: a string serializes with its quotes.
  if (value === undefined || value === null) return "absent"
  if (Array.isArray(value) && value.length === 0) return "absent"
  return JSON.stringify(value)
}

const RENDERED_COMPONENT_FIELDS = new Set<string>([
  "name",
  "roots",
  "publicApi",
  "languages",
  "frameworks",
  "description",
])

function renderDescription(description: string | null): string {
  return description === null ? "none" : inlineCode(description)
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i])
}
