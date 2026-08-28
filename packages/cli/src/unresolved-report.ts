import type { UnresolvedDeclaration } from "@aburi/core"

/**
 * How many patterns a line lists before it stops naming them.
 *
 * The same reason `reportSkipped` truncates and `reportUnrepresentable` does not: the manifest
 * still holds every pattern, so a reader who needs the rest opens the file the line names. A
 * `packages:` with fifty entries would otherwise be one unreadable line.
 */
const MAX_LISTED_PATTERNS = 10

/**
 * The lines describing manifests that declared packages and resolved none.
 *
 * One function because `aburi scan` and `aburi init` both say this, and both are reporting one
 * fact about one workspace. Two spellings would be two chances to describe it differently —
 * and the pairing rule below is a second condition that would then also live in two places.
 *
 * `fellBackToSingleComponent` adds a line rather than a clause, because it is a different fact
 * with a different condition: one manifest can be dead while another resolves, and then nothing
 * fell back at all. It is only said alongside a dead declaration, since on its own — a
 * workspace with no manager at all — describing the repository as one component is the right
 * answer rather than a consequence worth reporting.
 */
export function describeUnresolvedDeclarations(
  declarations: readonly UnresolvedDeclaration[],
  fellBackToSingleComponent: boolean,
): string[] {
  const lines = declarations.map(describeDeclaration)
  if (lines.length > 0 && fellBackToSingleComponent) {
    lines.push(
      "No workspace package was found, so the whole repository is described as one component.",
    )
  }
  return lines
}

function describeDeclaration(declaration: UnresolvedDeclaration): string {
  const total = declaration.patterns.length
  const listed = declaration.patterns.slice(0, MAX_LISTED_PATTERNS).map(quote).join(", ")
  const hidden = total - MAX_LISTED_PATTERNS
  return (
    `${declaration.manifestPath} declares ${total} ${declaration.tool} package pattern` +
    `${total === 1 ? "" : "s"} that named no package: ${listed}` +
    `${hidden > 0 ? `, and ${hidden} more` : ""}. ` +
    "Fix the patterns, or leave the field out if the workspace has no packages yet."
  )
}

/**
 * Quoted because a pattern can be empty or hold spaces, and an unquoted `` in a sentence is
 * nothing a reader can find in their manifest.
 */
function quote(pattern: string): string {
  return JSON.stringify(pattern)
}
