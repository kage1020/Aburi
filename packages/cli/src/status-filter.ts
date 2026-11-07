import { SYMBOL_CHANGE_STATUSES, type SymbolChangeStatus } from "@aburi/types"
import { CliError } from "./errors"
import { type FailOnClause, formatClause, statusesCounted } from "./fail-on"

export function parseFilter(value: string): SymbolChangeStatus[] {
  const segments = value.split(",").map((segment) => segment.trim())
  const refuse = (reason: string): never => {
    throw new CliError(
      `--filter value "${value}" is invalid: ${reason} The statuses are ${SYMBOL_CHANGE_STATUSES.join(", ")}.`,
      "input-error",
    )
  }
  if (segments.every((segment) => segment.length === 0)) {
    refuse(
      "it names no status, and a report filtered to nothing reads as a diff that found nothing.",
    )
  }
  const statuses = new Set<SymbolChangeStatus>()
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      refuse(`segment ${index + 1} of ${segments.length} is empty; remove the extra comma.`)
    }
    if (isStatus(segment)) {
      statuses.add(segment)
      continue
    }
    const head = segment.slice(0, segment.indexOf(":"))
    refuse(
      segment.includes(":") && isStatus(head)
        ? `"${segment}" is a --fail-on token, not a status; the report lists those changes under "${head}".`
        : `"${segment}" is no status.`,
    )
  }
  return [...statuses]
}

function isStatus(value: string): value is SymbolChangeStatus {
  return (SYMBOL_CHANGE_STATUSES as readonly string[]).includes(value)
}

/** One warning per clause that counts only changes `statuses` keeps out of `diff.md`. */
export function filteredOutClauses(
  clauses: readonly FailOnClause[],
  statuses: readonly SymbolChangeStatus[],
): string[] {
  const kept = new Set(statuses)
  const warnings = clauses.flatMap((clause) => {
    const counted = statusesCounted(clause.token)
    if (counted.some((status) => kept.has(status))) return []
    return [
      `⚠ --fail-on ${formatClause(clause)} counts ${counted.join(" and ")} changes, which --filter leaves out of diff.md.`,
    ]
  })
  return [...new Set(warnings)]
}
