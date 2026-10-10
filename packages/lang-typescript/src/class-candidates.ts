import type { ExtractionContext, SymbolCandidate, SymbolKind } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { hasChildOfType, makeSourceRange } from "./ast-helpers"
import { functionValuedField, isConstructorMember, memberSymbolSegment } from "./class-members"
import {
  type CandidateSink,
  foldMemberGroup,
  groupMemberDeclaration,
  type MemberGroup,
} from "./declaration-merge"
import { declaredOrDefaultQname } from "./declared-name"
import { readDecorators } from "./decorators"
import { exportEvidence, memberVisibility, topLevelVisibility } from "./export-evidence"
import { readLeadingJsDoc } from "./leading-jsdoc"
import { classMemberQname, makeTsSymbolId } from "./qname"
import { buildSignature } from "./signature"

export function addClassAndMembers(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
): void {
  const { name: className, qname } = declaredOrDefaultQname(node, "class", ctx, namespacePath)
  out.add({
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "class",
    extKind: null,
    name: qname,
    visibility: topLevelVisibility(node),
    decorators: readDecorators(node),
    signature: null,
    source: makeSourceRange(node, ctx),
    derivedBy: exportEvidence(node),
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  })

  const body = node.childForFieldName("body")
  if (body === null || className === null) return
  addClassMembers(node, body, ctx, [...namespacePath, className], out)
}

function addClassMembers(
  classNode: Node,
  body: Node,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
  out: CandidateSink,
): void {
  const byId = new Map<string, MemberGroup>()
  for (const member of body.namedChildren) {
    if (member === null) continue
    const segment = memberSymbolSegment(classNode, member)
    if (segment === null) continue
    const fieldFunction = functionValuedField(member)
    const candidate =
      fieldFunction === null
        ? makeMethodCandidate(member, segment, ctx, ownerChain)
        : makeFieldFunctionCandidate(member, fieldFunction, segment, ctx, ownerChain)
    groupMemberDeclaration(byId, candidate, hasChildOfType(member, "get"))
  }
  for (const group of byId.values()) {
    const folded = foldMemberGroup(group)
    if (folded !== null) out.add(folded)
  }
}

const ABSTRACT_DECLARATION = "abstract-declaration"

function makeMethodCandidate(
  node: Node,
  segment: string,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> {
  const kind: SymbolKind = isConstructorMember(node) ? "constructor" : "method"
  const isStatic = hasChildOfType(node, "static")
  const qname =
    kind === "constructor"
      ? classMemberQname(ownerChain, "constructor", "instance")
      : classMemberQname(ownerChain, segment, isStatic ? "static" : "instance")
  const derivedBy: string[] = [isStatic ? "static-method" : "class-method"]
  if (kind === "constructor") derivedBy.push("constructor-declaration")
  if (node.type === "abstract_method_signature") derivedBy.push(ABSTRACT_DECLARATION)
  if (hasChildOfType(node, "get") || hasChildOfType(node, "set")) {
    derivedBy.push("accessor-declaration")
  }
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind,
    extKind: null,
    name: qname,
    visibility: memberVisibility(node),
    decorators: readDecorators(node),
    signature: buildSignature(node, readLeadingJsDoc(node)),
    source: makeSourceRange(node, ctx),
    derivedBy,
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
}

function makeFieldFunctionCandidate(
  field: Node,
  value: Node,
  segment: string,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> {
  const isStatic = hasChildOfType(field, "static")
  const qname = classMemberQname(ownerChain, segment, isStatic ? "static" : "instance")
  const derivedBy = [isStatic ? "static-method" : "class-method", "field-assigned-function"]
  if (hasChildOfType(field, "accessor")) derivedBy.push("accessor-declaration")
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "method",
    extKind: null,
    name: qname,
    visibility: memberVisibility(field),
    decorators: readDecorators(field),
    signature: buildSignature(value, readLeadingJsDoc(field)),
    source: makeSourceRange(field, ctx),
    derivedBy,
    bodyNode: value.childForFieldName("body"),
    fullNode: value,
  }
}
