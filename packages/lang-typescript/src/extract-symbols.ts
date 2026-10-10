import type { ExtractionContext, SymbolCandidate } from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import {
  AMBIENT_DECLARATION_TYPE,
  findChild,
  firstNonCommentChild,
  inAmbientContext,
  makeSourceRange,
  nameFieldText,
} from "./ast-helpers"
import {
  type CallExtractionState,
  makeCallExtractionState,
  visitCallStatement,
} from "./call-symbols"
import { addClassAndMembers } from "./class-candidates"
import { type CandidateSink, makeCandidateSink } from "./declaration-merge"
import { declaredOrDefaultQname } from "./declared-name"
import { readDecorators } from "./decorators"
import {
  exportEvidence,
  isDefaultExport,
  promoteDefaultExports,
  topLevelVisibility,
} from "./export-evidence"
import { readLeadingJsDoc } from "./leading-jsdoc"
import { makeTsSymbolId, nestedQname } from "./qname"
import { buildSignature } from "./signature"
import {
  ENUM_SHAPE,
  INTERFACE_SHAPE,
  makeSignaturelessCandidate,
  makeTypeDeclarationCandidate,
  TYPE_ALIAS_SHAPE,
} from "./type-candidates"
import { makeVariableCandidates } from "./variable-candidates"

export function extractSymbols(tree: Tree, ctx: ExtractionContext): SymbolCandidate<Node>[] {
  const root = tree.rootNode
  if (root === null) return []
  const out = makeCandidateSink()
  const callState = makeCallExtractionState()
  for (const stmt of root.namedChildren) {
    if (stmt !== null) visitStatement(stmt, ctx, [], out, callState)
  }
  return promoteDefaultExports(root, out.list())
}

function visitStatement(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
  callState: CallExtractionState,
): void {
  if (node.type === "export_statement") {
    const declarationNode = exportedDeclaration(node)
    if (declarationNode === null) return
    visitStatement(declarationNode, ctx, namespacePath, out, callState)
    return
  }
  if (node.type === AMBIENT_DECLARATION_TYPE) {
    const declarationNode = ambientDeclaration(node)
    if (declarationNode === null) return
    visitStatement(declarationNode, ctx, namespacePath, ambientSink(out), callState)
    return
  }
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
      out.add(makeFunctionCandidate(node, ctx, namespacePath))
      return
    case "function_expression":
    case "arrow_function":
      if (isDefaultExport(node)) {
        out.add(makeFunctionCandidate(node, ctx, namespacePath))
      }
      return
    case "class_declaration":
    case "abstract_class_declaration":
      addClassAndMembers(node, ctx, namespacePath, out)
      return
    case "class":
      // Anonymous `export default class {}` uses tree-sitter's `class` node type.
      if (isDefaultExport(node)) {
        addClassAndMembers(node, ctx, namespacePath, out)
      }
      return
    case "interface_declaration":
      out.add(makeTypeDeclarationCandidate(node, ctx, namespacePath, INTERFACE_SHAPE))
      return
    case "type_alias_declaration":
      out.add(makeTypeDeclarationCandidate(node, ctx, namespacePath, TYPE_ALIAS_SHAPE))
      return
    case "enum_declaration":
      out.add(makeTypeDeclarationCandidate(node, ctx, namespacePath, ENUM_SHAPE))
      return
    case "internal_module":
    case "module":
    case "namespace_declaration":
      addNamespaceAndBody(node, ctx, namespacePath, out, callState)
      return
    case "lexical_declaration":
    case "variable_declaration":
      for (const declarator of node.namedChildren) {
        if (declarator === null || declarator.type !== "variable_declarator") continue
        for (const candidate of makeVariableCandidates(declarator, node, ctx, namespacePath)) {
          out.add(candidate)
        }
      }
      return
    case "expression_statement": {
      const wrapped = wrappedDeclaration(node)
      if (wrapped !== null) {
        visitStatement(wrapped, ctx, namespacePath, out, callState)
        return
      }
      if (namespacePath.length !== 0) return
      const candidate = visitCallStatement(node, ctx, callState)
      if (candidate !== null) out.add(candidate)
      return
    }
    default:
      return
  }
}

const WRAPPED_DECLARATION_TYPES: ReadonlySet<string> = new Set(["internal_module"])

function exportedDeclaration(statement: Node): Node | null {
  return (
    statement.childForFieldName("declaration") ??
    statement.namedChildren.find(
      (c): c is Node => c !== null && c.type !== "comment" && c.type !== "decorator",
    ) ??
    null
  )
}

function wrappedDeclaration(statement: Node): Node | null {
  if (statement.namedChildCount !== 1) return null
  const only = statement.namedChild(0)
  if (only === null || !WRAPPED_DECLARATION_TYPES.has(only.type)) return null
  return only
}

function ambientDeclaration(node: Node): Node | null {
  const inner = firstNonCommentChild(node)
  if (inner === null || inner.type === "statement_block") return null
  return inner
}

const AMBIENT_DECLARATION = "ambient-declaration"

function ambientSink(out: CandidateSink): CandidateSink {
  return {
    add(candidate) {
      if (candidate.derivedBy.includes(AMBIENT_DECLARATION)) {
        out.add(candidate)
        return
      }
      out.add({ ...candidate, derivedBy: [...candidate.derivedBy, AMBIENT_DECLARATION] })
    },
    list: () => out.list(),
  }
}

function makeFunctionCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const { qname } = declaredOrDefaultQname(node, "function", ctx, namespacePath)
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "function",
    extKind: null,
    name: qname,
    visibility: topLevelVisibility(node),
    decorators: readDecorators(node),
    signature: buildSignature(node, readLeadingJsDoc(node)),
    source: makeSourceRange(node, ctx),
    derivedBy: exportEvidence(node),
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
}

function declaredNamespaceName(node: Node, body: Node | null): string | null {
  if (body === null) return null
  const name = node.childForFieldName("name")
  if (name === null || name.isMissing || name.type === "string") return null
  return name.text.length > 0 ? name.text : null
}

function addNamespaceAndBody(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
  callState: CallExtractionState,
): void {
  const body = node.childForFieldName("body") ?? findChild(node, "statement_block")
  const declaredName = declaredNamespaceName(node, body)
  if (declaredName === null || body === null) return
  const [head, ...rest] = declaredName.split(".")
  if (head === undefined) return
  const path = [...namespacePath, head]
  const namespaceCandidate = () =>
    makeSignaturelessCandidate(
      node,
      ctx,
      nestedQname(path),
      "namespace",
      "namespace-declaration",
      null,
    )
  out.add(namespaceCandidate())
  const members = mergesWithClass(node, head)
    ? staticMemberSink(out, nestedQname(path), ctx.file.path)
    : out
  for (const segment of rest) {
    path.push(segment)
    members.add(namespaceCandidate())
  }
  const everyStatementUnderMember = rest.length > 0 || inAmbientContext(node)
  for (const stmt of body.namedChildren) {
    if (stmt === null) continue
    const underMember = everyStatementUnderMember || stmt.type === "export_statement"
    visitStatement(stmt, ctx, path, underMember ? members : out, callState)
  }
}

function mergesWithClass(namespaceNode: Node, name: string): boolean {
  let statement = namespaceNode
  while (statement.parent !== null && !STATEMENT_LISTS.has(statement.parent.type)) {
    statement = statement.parent
  }
  const scope = statement.parent
  if (scope === null) return false
  return scope.namedChildren.some((sibling) => {
    const declaration = sibling === null ? null : unwrappedDeclaration(sibling)
    return (
      declaration !== null &&
      CLASS_DECLARATION_TYPES.has(declaration.type) &&
      nameFieldText(declaration) === name
    )
  })
}

const STATEMENT_LISTS: ReadonlySet<string> = new Set(["program", "statement_block"])

const CLASS_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
])

function unwrappedDeclaration(statement: Node): Node | null {
  if (statement.type === "export_statement") {
    const declaration = exportedDeclaration(statement)
    return declaration === null ? null : unwrappedDeclaration(declaration)
  }
  if (statement.type === AMBIENT_DECLARATION_TYPE) {
    const declaration = ambientDeclaration(statement)
    return declaration === null ? null : unwrappedDeclaration(declaration)
  }
  return statement
}

function staticMemberSink(out: CandidateSink, owner: string, file: string): CandidateSink {
  const instancePrefix = `${owner}.`
  return {
    add(candidate) {
      if (!candidate.name.startsWith(instancePrefix)) {
        out.add(candidate)
        return
      }
      const name = `${owner}::${candidate.name.slice(instancePrefix.length)}`
      out.add({ ...candidate, id: makeTsSymbolId(file, name), name })
    },
    list: () => out.list(),
  }
}
