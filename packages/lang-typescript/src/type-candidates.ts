import type { ExtractionContext, SymbolCandidate, SymbolKind } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, makeSourceRange } from "./ast-helpers"
import { requireDeclarationName } from "./declared-name"
import { exportEvidence, topLevelVisibility } from "./export-evidence"
import { makeTsSymbolId, nestedQname } from "./qname"

interface TypeDeclarationShape {
  kind: SymbolKind
  refusalName: string
  derivedByToken: string
  bodyOf: (node: Node) => Node | null
}

export const INTERFACE_SHAPE: TypeDeclarationShape = {
  kind: "interface",
  refusalName: "interface",
  derivedByToken: "interface-declaration",
  bodyOf: (node) => findChild(node, "object_type") ?? findChild(node, "interface_body"),
}

export const TYPE_ALIAS_SHAPE: TypeDeclarationShape = {
  kind: "type",
  refusalName: "type alias",
  derivedByToken: "type-alias",
  bodyOf: () => null,
}

export const ENUM_SHAPE: TypeDeclarationShape = {
  kind: "enum",
  refusalName: "enum",
  derivedByToken: "enum-declaration",
  bodyOf: () => null,
}

export function makeTypeDeclarationCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  shape: TypeDeclarationShape,
): SymbolCandidate<Node> {
  const name = requireDeclarationName(node, shape.refusalName, ctx.file.path)
  const qname = nestedQname([...namespacePath, name])
  return makeSignaturelessCandidate(
    node,
    ctx,
    qname,
    shape.kind,
    shape.derivedByToken,
    shape.bodyOf(node),
  )
}

export function makeSignaturelessCandidate(
  node: Node,
  ctx: ExtractionContext,
  qname: string,
  kind: SymbolKind,
  derivedByToken: string,
  bodyNode: Node | null,
): SymbolCandidate<Node> {
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind,
    extKind: null,
    name: qname,
    visibility: topLevelVisibility(node),
    decorators: [],
    signature: null,
    source: makeSourceRange(node, ctx),
    derivedBy: [derivedByToken, ...exportEvidence(node)],
    bodyNode,
    fullNode: node,
  }
}
