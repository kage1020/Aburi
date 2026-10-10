import type { UnresolvedDeclaration } from "@aburi/core"
import { joinCapped } from "./listing"

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

function quote(pattern: string): string {
  return JSON.stringify(pattern)
}
