import { compareBy } from "@aburi/core"
import type { MergedDeclaration, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { inAmbientContext } from "./ast-helpers"

export interface CandidateSink {
  add(candidate: SymbolCandidate<Node>): void
  list(): SymbolCandidate<Node>[]
}

type DeclarationGroup = [SymbolCandidate<Node>, ...SymbolCandidate<Node>[]]

export function makeCandidateSink(): CandidateSink {
  const byId = new Map<string, DeclarationGroup>()
  return {
    add(candidate) {
      const group = byId.get(candidate.id)
      if (group === undefined) byId.set(candidate.id, [candidate])
      else group.push(candidate)
    },
    list() {
      const symbols: SymbolCandidate<Node>[] = []
      for (const group of byId.values()) {
        const lead = leadOf(group)
        if (lead !== null) symbols.push(foldDeclarations(group, lead))
      }
      return symbols.sort(compareBy((candidate) => candidate.id))
    },
  }
}

function leadOf(group: readonly SymbolCandidate<Node>[]): SymbolCandidate<Node> | null {
  return group.find((declaration) => !isOverloadSignature(declaration.fullNode)) ?? null
}

function isOverloadSignature(node: Node): boolean {
  return (
    (node.type === "function_signature" || node.type === "method_signature") &&
    !inAmbientContext(node)
  )
}

const MERGED_DECLARATION = "declaration-merged"

function foldDeclarations(
  declarations: readonly SymbolCandidate<Node>[],
  lead: SymbolCandidate<Node>,
): SymbolCandidate<Node> {
  if (declarations.length < 2) return lead
  const decorators: SymbolCandidate<Node>["decorators"] = []
  const derivedBy: string[] = []
  const merged: MergedDeclaration<Node>[] = [...(lead.mergedDeclarations ?? [])]
  for (const declaration of declarations) {
    decorators.push(...declaration.decorators)
    for (const token of declaration.derivedBy) {
      if (!derivedBy.includes(token)) derivedBy.push(token)
    }
    if (declaration === lead) continue
    merged.push({ bodyNode: declaration.bodyNode, fullNode: declaration.fullNode })
    merged.push(...(declaration.mergedDeclarations ?? []))
  }
  if (!derivedBy.includes(MERGED_DECLARATION)) derivedBy.push(MERGED_DECLARATION)
  return { ...lead, decorators, derivedBy, mergedDeclarations: merged }
}

interface MemberDeclaration {
  candidate: SymbolCandidate<Node>
  isGetter: boolean
}

export type MemberGroup = [MemberDeclaration, ...MemberDeclaration[]]

export function groupMemberDeclaration(
  byId: Map<string, MemberGroup>,
  candidate: SymbolCandidate<Node>,
  isGetter: boolean,
): void {
  const group = byId.get(candidate.id)
  if (group === undefined) byId.set(candidate.id, [{ candidate, isGetter }])
  else group.push({ candidate, isGetter })
}

export function foldMemberGroup(group: MemberGroup): SymbolCandidate<Node> | null {
  const leads = group.filter((member) => !isOverloadSignature(member.candidate.fullNode))
  const lead = leads.find((member) => member.isGetter) ?? leads[0]
  const declarations = group.map((member) => member.candidate)
  return lead === undefined ? null : foldDeclarations(declarations, lead.candidate)
}
