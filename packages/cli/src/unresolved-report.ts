import type { UnresolvedDeclaration } from "@aburi/core"
import { joinCapped } from "./listing"

/**
 * The lines describing manifests that declared packages and resolved none, shared by
 * `aburi scan` and `aburi init`.
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
  return (
    `${declaration.manifestPath} declares ${total} ${declaration.tool} package pattern` +
    `${total === 1 ? "" : "s"} that named no package: ${joinCapped(declaration.patterns.map(quote))}. ` +
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
