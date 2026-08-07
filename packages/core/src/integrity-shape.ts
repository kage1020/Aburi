import type { IntegrityViolation } from "./errors"

/**
 * Invariant #20 (ir-schema.md §14): the Document carries every container and field the other
 * invariants read.
 *
 * The schema guarantees this shape, but nothing in the pipeline runs a schema validator:
 * `readIR` checks `$schema` and three array keys and then hands the object straight to
 * `checkIRIntegrity`, which is therefore the only gate a Document read off disk passes
 * through. A gate whose answer to a malformed input is a `TypeError` has no answer — the
 * caller asked which invariant broke and got an internal crash, which is exactly the
 * question the list exists to answer.
 *
 * What is checked is this module's own precondition, not the schema's `required` list. Only
 * the fields `checkIRIntegrity` dereferences appear here, so the two cannot drift into
 * disagreement: a check that stops reading a field drops its line from this file, and one
 * that starts reading a new field is the same edit in two places rather than a silent
 * dependency on a validator nobody runs.
 */
export function checkDocumentShape(document: unknown): IntegrityViolation[] {
  const out: IntegrityViolation[] = []
  if (!isRecord(document)) {
    out.push(violation("$", `Document is ${describe(document)}, not an object`))
    return out
  }
  for (const key of ["components", "symbols", "dependencies"] as const) {
    requireArray(document[key], key, key, out)
  }
  requireRecord(document.stats, "stats", "stats", out)
  if (requireRecord(document.workspace, "workspace", "workspace", out)) {
    const workspace = document.workspace as Record<string, unknown>
    requireArray(workspace.managers, "workspace.managers", "managers", out)
    requireArray(workspace.languages, "workspace.languages", "languages", out)
    forEachRecord(workspace.managers, "workspace.managers", out, (manager, subject) => {
      requireString(manager.tool, subject, "tool", out)
      requireArray(manager.roots, subject, "roots", out)
    })
  }
  forEachRecord(document.components, "components", out, (component, subject) => {
    requireString(component.id, subject, "id", out)
    requireArray(component.roots, subject, "roots", out)
    if (component.publicApi !== undefined) {
      requireArray(component.publicApi, subject, "publicApi", out)
    }
  })
  forEachRecord(document.dependencies, "dependencies", out, (dep, subject) => {
    for (const key of ["from", "to", "via"] as const) requireString(dep[key], subject, key, out)
  })
  forEachRecord(document.symbols, "symbols", out, (symbol, subject) => {
    for (const key of ["id", "name", "kind", "language", "confidence"] as const) {
      requireString(symbol[key], subject, key, out)
    }
    if (requireRecord(symbol.source, subject, "source", out)) {
      requireString(
        (symbol.source as Record<string, unknown>).file,
        `${subject}.source`,
        "file",
        out,
      )
    }
    for (const key of ["decorators", "rules", "effects", "calls"] as const) {
      requireArray(symbol[key], subject, key, out)
    }
    forEachRecord(symbol.effects, `${subject}.effects`, out, (effect, effectSubject) => {
      requireString(effect.id, effectSubject, "id", out)
      requireString(effect.target, effectSubject, "target", out)
    })
    forEachRecord(symbol.calls, `${subject}.calls`, out, (call, callSubject) => {
      requireString(call.target, callSubject, "target", out)
      requireNumber(call.line, callSubject, "line", out)
    })
    for (const key of ["decorators", "rules"] as const) {
      forEachRecord(symbol[key], `${subject}.${key}`, out, (entry, entrySubject) => {
        requireNumber(entry.line, entrySubject, "line", out)
      })
    }
  })
  return out
}

function violation(subject: string, message: string): IntegrityViolation {
  return { invariant: 20, subject, message }
}

function requireArray(
  value: unknown,
  subject: string,
  field: string,
  out: IntegrityViolation[],
): boolean {
  if (Array.isArray(value)) return true
  out.push(violation(subject, `"${field}" is ${describe(value)}, not an array`))
  return false
}

function requireRecord(
  value: unknown,
  subject: string,
  field: string,
  out: IntegrityViolation[],
): boolean {
  if (isRecord(value)) return true
  out.push(violation(subject, `"${field}" is ${describe(value)}, not an object`))
  return false
}

function requireString(
  value: unknown,
  subject: string,
  field: string,
  out: IntegrityViolation[],
): void {
  if (typeof value === "string") return
  out.push(violation(subject, `"${field}" is ${describe(value)}, not a string`))
}

function requireNumber(
  value: unknown,
  subject: string,
  field: string,
  out: IntegrityViolation[],
): void {
  if (typeof value === "number" && Number.isFinite(value)) return
  out.push(violation(subject, `"${field}" is ${describe(value)}, not a number`))
}

/**
 * Walk an array of records, reporting a non-record element rather than descending into it.
 * The array itself has already been reported when it is not one, so a miss here is silent
 * on purpose — one violation per defect.
 */
function forEachRecord(
  value: unknown,
  collection: string,
  out: IntegrityViolation[],
  check: (record: Record<string, unknown>, subject: string) => void,
): void {
  if (!Array.isArray(value)) return
  for (const [index, entry] of value.entries()) {
    const subject = `${collection}[${index}]`
    if (!isRecord(entry)) {
      out.push(violation(subject, `entry is ${describe(entry)}, not an object`))
      continue
    }
    check(entry, subject)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Name a value the way an error message should: its type, or `null` / `absent` / an array. */
function describe(value: unknown): string {
  if (value === undefined) return "absent"
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `a ${typeof value}`
}
