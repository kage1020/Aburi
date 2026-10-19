import type { UnnameableRoot, UnnameableSite, UnresolvedDeclaration } from "@aburi/core"
import { joinCapped } from "./listing"

export const UNNAMEABLE_BECAUSE: Record<UnnameableSite["reason"], string> = {
  "unspellable-name": 'holds a backslash, and "/" is the only separator a Document path has',
  "drive-shaped-name":
    'opens with one ASCII letter and ":", which a Document path reads as a Windows drive',
}

export interface WorkspaceDetection {
  unresolvedDeclarations: readonly UnresolvedDeclaration[]
  unnameableRoots: readonly UnnameableRoot[]
  fellBackToSingleComponent: boolean
}

export function describeWorkspaceDetection(detection: WorkspaceDetection): string[] {
  const lines = [
    ...detection.unresolvedDeclarations.map(describeDeclaration),
    ...detection.unnameableRoots.map(describeUnnameableRoot),
  ]
  if (lines.length > 0 && detection.fellBackToSingleComponent) {
    const other = detection.unnameableRoots.length > 0 ? "other " : ""
    lines.push(
      `No ${other}workspace package was found, so the whole repository is described as one component.`,
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

function describeUnnameableRoot(root: UnnameableRoot): string {
  return (
    `${root.tool} package "${root.relativeRoot}" (${root.manifestPath}) is not a component and not on workspace.managers[].roots, and none of its files can be scanned: ` +
    `"${root.unnameablePrefix}" ${UNNAMEABLE_BECAUSE[root.reason]}, so no IR can name it. Rename it.`
  )
}

function quote(pattern: string): string {
  return JSON.stringify(pattern)
}
