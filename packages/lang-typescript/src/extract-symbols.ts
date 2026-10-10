import { CoreError, compareBy } from "@aburi/core"
import type {
  ExtractionContext,
  MergedDeclaration,
  SymbolCandidate,
  SymbolKind,
  Visibility,
} from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import {
  AMBIENT_DECLARATION_TYPE,
  asFunctionValue,
  findChild,
  firstNonCommentChild,
  hasChildOfType,
  hasExportModifier,
  inAmbientContext,
  makeSourceRange,
  nameFieldText,
  statementParent,
  unwrapValue,
} from "./ast-helpers"
import {
  type CallExtractionState,
  inlineHandlers,
  makeCallExtractionState,
  visitCallStatement,
} from "./call-symbols"
import {
  functionValuedField,
  hasPrivateName,
  isConstructorMember,
  memberSymbolSegment,
} from "./class-members"
import { readDecorators } from "./decorators"
import { objectEntryOf, objectLiteralOf } from "./object-members"
import { collectPatternBindings } from "./pattern-bindings"
import { classMemberQname, defaultExportQname, makeTsSymbolId, nestedQname } from "./qname"
import { buildSignature } from "./signature"

function refuseAnonymousId(message: string, value: string): never {
  throw new CoreError(message, { code: "anonymous-symbol-id-attempted", value })
}

function requireDeclarationName(node: Node, kind: string, file: string): string {
  const name = nameFieldText(node)
  if (name !== null) return name
  return refuseAnonymousId(
    `Missing name field on ${kind} declaration in ${file}:${node.startPosition.row + 1}; the tree-sitter grammar produced an unexpected shape and this plugin refuses to fabricate a placeholder id`,
    `${file}:${kind}`,
  )
}

function declaredOrDefaultQname(
  node: Node,
  what: "class" | "function",
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): { name: string | null; qname: string } {
  const name = nameFieldText(node)
  if (name !== null) return { name, qname: nestedQname([...namespacePath, name]) }
  if (!isDefaultExport(node)) {
    refuseAnonymousId(
      `Anonymous ${what} at ${ctx.file.path}:${node.startPosition.row + 1} is neither named nor a default export; refusing to synthesize a <default> id`,
      ctx.file.path,
    )
  }
  return { name: null, qname: defaultExportQname() }
}

export function extractSymbols(tree: Tree, ctx: ExtractionContext): SymbolCandidate<Node>[] {
  const root = tree.rootNode
  if (root === null) return []
  const out = makeCandidateSink()
  visitModuleLevel(root, ctx, [], out, makeCallExtractionState())
  return promoteDefaultExports(out.list(), defaultExportedNames(root))
}

interface CandidateSink {
  add(candidate: SymbolCandidate<Node>): void
  list(): SymbolCandidate<Node>[]
}

/** Declarations of one entity, in source order. A group exists because something is in it. */
type DeclarationGroup = [SymbolCandidate<Node>, ...SymbolCandidate<Node>[]]

function makeCandidateSink(): CandidateSink {
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

/** Rationale recorded on a Symbol more than one declaration wrote. */
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

function visitModuleLevel(
  parent: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
  callState: CallExtractionState,
): void {
  for (const stmt of parent.namedChildren) {
    if (stmt === null) continue
    visitStatement(stmt, ctx, namespacePath, out, callState)
  }
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

/** What `derivedBy` says when a Symbol was declared under a `declare`. */
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

function addClassAndMembers(
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
    visibility: computeTopLevelVisibility(node),
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

/** One member declaration, with the one thing about it that decides which of a pair leads. */
interface MemberDeclaration {
  candidate: SymbolCandidate<Node>
  isGetter: boolean
}

/** Declarations of one member, in source order. A group exists because something is in it. */
type MemberGroup = [MemberDeclaration, ...MemberDeclaration[]]

/** Starts the group this member's id has, or adds the declaration to the one already open. */
function groupMemberDeclaration(
  byId: Map<string, MemberGroup>,
  candidate: SymbolCandidate<Node>,
  isGetter: boolean,
): void {
  const group = byId.get(candidate.id)
  if (group === undefined) byId.set(candidate.id, [{ candidate, isGetter }])
  else group.push({ candidate, isGetter })
}

function foldMemberGroup(group: MemberGroup): SymbolCandidate<Node> | null {
  const leads = group.filter((member) => !isOverloadSignature(member.candidate.fullNode))
  const lead = leads.find((member) => member.isGetter) ?? leads[0]
  const declarations = group.map((member) => member.candidate)
  return lead === undefined ? null : foldDeclarations(declarations, lead.candidate)
}

function makeFunctionCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const { qname } = declaredOrDefaultQname(node, "function", ctx, namespacePath)
  const jsDoc = readLeadingJsDoc(node)
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "function",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(node),
    decorators: readDecorators(node),
    signature: buildSignature(node, jsDoc),
    source: makeSourceRange(node, ctx),
    derivedBy: exportEvidence(node),
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
}

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
  const jsDoc = readLeadingJsDoc(node)
  const signature = buildSignature(node, jsDoc)
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
    signature,
    source: makeSourceRange(node, ctx),
    derivedBy,
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
}

/** What `derivedBy` says when a member is declared `abstract`. */
const ABSTRACT_DECLARATION = "abstract-declaration"

function makeFieldFunctionCandidate(
  field: Node,
  value: Node,
  segment: string,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> {
  const isStatic = hasChildOfType(field, "static")
  const qname = classMemberQname(ownerChain, segment, isStatic ? "static" : "instance")
  const jsDoc = readLeadingJsDoc(field)
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "method",
    extKind: null,
    name: qname,
    visibility: memberVisibility(field),
    decorators: readDecorators(field),
    signature: buildSignature(value, jsDoc),
    source: makeSourceRange(field, ctx),
    derivedBy: fieldDerivedBy(field, isStatic),
    bodyNode: value.childForFieldName("body"),
    fullNode: value,
  }
}

function fieldDerivedBy(field: Node, isStatic: boolean): string[] {
  const out = [isStatic ? "static-method" : "class-method", "field-assigned-function"]
  if (hasChildOfType(field, "accessor")) out.push("accessor-declaration")
  return out
}

function memberVisibility(member: Node): Visibility {
  return hasPrivateName(member) ? "private" : readAccessibilityKeyword(member)
}

/** What one named, bodyless-by-default type declaration contributes beyond its name. */
interface TypeDeclarationShape {
  kind: SymbolKind
  /** How the kind is named in the refusal message. */
  label: string
  /** The `derivedBy` token for this kind of declaration. */
  token: string
  bodyOf: (node: Node) => Node | null
}

const INTERFACE_SHAPE: TypeDeclarationShape = {
  kind: "interface",
  label: "interface",
  token: "interface-declaration",
  bodyOf: (node) => findChild(node, "object_type") ?? findChild(node, "interface_body"),
}

const TYPE_ALIAS_SHAPE: TypeDeclarationShape = {
  kind: "type",
  label: "type alias",
  token: "type-alias",
  bodyOf: () => null,
}

const ENUM_SHAPE: TypeDeclarationShape = {
  kind: "enum",
  label: "enum",
  token: "enum-declaration",
  bodyOf: () => null,
}

function makeTypeDeclarationCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  shape: TypeDeclarationShape,
): SymbolCandidate<Node> {
  const name = requireDeclarationName(node, shape.label, ctx.file.path)
  const qname = nestedQname([...namespacePath, name])
  return makeBodylessCandidate(node, ctx, qname, shape.kind, shape.token, shape.bodyOf(node))
}

/** The candidate shape every declaration with no signature and no decorators shares. */
function makeBodylessCandidate(
  node: Node,
  ctx: ExtractionContext,
  qname: string,
  kind: SymbolKind,
  token: string,
  bodyNode: Node | null,
): SymbolCandidate<Node> {
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind,
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(node),
    decorators: [],
    signature: null,
    source: makeSourceRange(node, ctx),
    derivedBy: [token, ...exportEvidence(node)],
    bodyNode,
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
    makeBodylessCandidate(node, ctx, nestedQname(path), "namespace", "namespace-declaration", null)
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

/** The nodes whose children are statements: a module, and a namespace's body. */
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

function makeVariableCandidates(
  declarator: Node,
  statement: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node>[] {
  const nameNode = declarator.childForFieldName("name")
  if (nameNode !== null && isBindingPattern(nameNode)) {
    const refuse = (node: Node): never =>
      refuseAnonymousId(
        `Unmodelled node "${node.type}" inside a destructuring pattern at ${nameNode.startPosition.row + 1}; refusing to report bindings this walk may have missed`,
        node.type,
      )
    return collectPatternBindings(nameNode, refuse).map((binding) =>
      makeDestructuredCandidate(binding, statement, ctx, namespacePath),
    )
  }
  return makeVariableCandidate(declarator, statement, ctx, namespacePath)
}

function makeVariableCandidate(
  declarator: Node,
  statement: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node>[] {
  const name = nameFieldText(declarator)
  if (name === null) return []
  const initializer = declarator.childForFieldName("value")
  const value = initializer === null ? null : asFunctionValue(initializer)
  const qname = nestedQname([...namespacePath, name])
  const id = makeTsSymbolId(ctx.file.path, qname)
  if (value !== null) {
    const jsDoc = readLeadingJsDoc(statement)
    return [
      {
        id,
        kind: "function",
        extKind: null,
        name: qname,
        visibility: computeTopLevelVisibility(statement),
        decorators: [],
        signature: buildSignature(value, jsDoc),
        source: makeSourceRange(statement, ctx),
        derivedBy: ["variable-assigned-function", ...exportEvidence(statement)],
        bodyNode: value.childForFieldName("body"),
        fullNode: value,
      },
    ]
  }
  const object = initializer === null ? null : objectLiteralOf(initializer)
  if (object !== null) {
    return [
      {
        id,
        kind: "const",
        extKind: null,
        name: qname,
        visibility: computeTopLevelVisibility(statement),
        decorators: [],
        signature: null,
        source: makeSourceRange(statement, ctx),
        derivedBy: [OBJECT_LITERAL_INITIALIZER, ...exportEvidence(statement)],
        bodyNode: object,
        fullNode: statement,
      },
      ...objectMemberCandidates(object, ctx, [...namespacePath, name]),
    ]
  }
  const [lead, ...rest] = initializer === null ? [] : wrappedFunctions(initializer, statement)
  const candidate: SymbolCandidate<Node> = {
    id,
    kind: "const",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(statement),
    decorators: [],
    signature: null,
    source: makeSourceRange(statement, ctx),
    // Says why a const has a body at all, as `inline-handler` does for a registration.
    derivedBy:
      lead === undefined
        ? exportEvidence(statement)
        : ["call-argument-function", ...exportEvidence(statement)],
    bodyNode: lead?.bodyNode ?? null,
    fullNode: statement,
    ...(rest.length > 0 ? { mergedDeclarations: rest } : {}),
  }
  return [candidate]
}

/** What `derivedBy` says when a binding's body is the object literal it is initialised by. */
const OBJECT_LITERAL_INITIALIZER = "object-literal-initializer"

function objectMemberCandidates(
  object: Node,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node>[] {
  const byId = new Map<string, MemberGroup>()
  const collect = (current: Node, chain: readonly string[]): void => {
    for (const entry of current.namedChildren) {
      if (entry === null) continue
      const read = objectEntryOf(entry)
      if (read === null) continue
      if (read.object !== null) {
        collect(read.object, [...chain, read.segment])
        continue
      }
      const candidate = makeObjectMemberCandidate(entry, read.fn, read.segment, ctx, chain)
      groupMemberDeclaration(byId, candidate, hasChildOfType(entry, "get"))
    }
  }
  collect(object, ownerChain)
  // No overload signature reaches an object literal, so every group has a lead.
  return [...byId.values()]
    .map(foldMemberGroup)
    .filter((candidate): candidate is SymbolCandidate<Node> => candidate !== null)
}

function makeObjectMemberCandidate(
  entry: Node,
  fn: Node,
  segment: string,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> {
  const qname = nestedQname([...ownerChain, segment])
  const derivedBy = [OBJECT_METHOD]
  if (entry.type === "pair") derivedBy.push(PROPERTY_ASSIGNED_FUNCTION)
  if (hasChildOfType(entry, "get") || hasChildOfType(entry, "set")) {
    derivedBy.push("accessor-declaration")
  }
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "method",
    extKind: null,
    name: qname,
    visibility: "public",
    decorators: [],
    signature: buildSignature(fn, readLeadingJsDoc(entry)),
    source: makeSourceRange(entry, ctx),
    derivedBy,
    bodyNode: fn.childForFieldName("body"),
    fullNode: fn,
  }
}

/** What `derivedBy` says when a Symbol is a member of an object literal. */
const OBJECT_METHOD = "object-method"

/** What `derivedBy` adds when that member is a property holding a function, not a method. */
const PROPERTY_ASSIGNED_FUNCTION = "property-assigned-function"

function wrappedFunctions(initializer: Node, statement: Node): MergedDeclaration<Node>[] {
  const call = unwrapValue(initializer)
  return call.type === "call_expression" ? inlineHandlers(call, statement) : []
}

/** The two shapes a `variable_declarator` uses in place of a name. */
function isBindingPattern(node: Node): boolean {
  return node.type === "object_pattern" || node.type === "array_pattern"
}

function makeDestructuredCandidate(
  binding: Node,
  statement: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const qname = nestedQname([...namespacePath, binding.text])
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "const",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(statement),
    decorators: [],
    signature: null,
    source: makeSourceRange(statement, ctx),
    derivedBy: ["destructured-binding", ...exportEvidence(statement)],
    bodyNode: null,
    fullNode: statement,
  }
}

function exportEvidence(node: Node): string[] {
  if (isDefaultExport(node)) return [EXPORT_DEFAULT]
  return hasExportModifier(node) ? [EXPORT_KEYWORD] : []
}

function computeTopLevelVisibility(node: Node): Visibility {
  return exportEvidence(node).length > 0 ? "public" : "internal"
}

function readAccessibilityKeyword(node: Node): Visibility {
  const modifier = findChild(node, "accessibility_modifier")
  if (modifier === null) return "public"
  switch (modifier.text) {
    case "private":
      return "private"
    case "protected":
      return "protected"
    default:
      return "public"
  }
}

/** The `default` an `export_statement` is written with is an anonymous token, hence the child scan. */
function isDefaultExport(node: Node): boolean {
  const parent = statementParent(node)
  if (parent === null || parent.type !== "export_statement") return false
  return hasChildOfType(parent, "default")
}

/** What `derivedBy` says when a Symbol is the module's default export. */
const EXPORT_DEFAULT = "export-default"

/** What `derivedBy` says when a Symbol's declaration carries the `export` keyword. */
const EXPORT_KEYWORD = "export-keyword"

function defaultExportedNames(root: Node): ReadonlySet<string> {
  const names = new Set<string>()
  for (const stmt of root.namedChildren) {
    if (stmt === null || stmt.type !== "export_statement") continue
    if (!hasChildOfType(stmt, "default")) continue
    const value = stmt.childForFieldName("value")
    if (value === null) continue
    const inner = unwrapValue(value)
    if (inner.type !== "identifier") continue
    names.add(inner.text)
  }
  return names
}

function promoteDefaultExports(
  candidates: SymbolCandidate<Node>[],
  names: ReadonlySet<string>,
): SymbolCandidate<Node>[] {
  if (names.size === 0) return candidates
  return candidates.map((candidate): SymbolCandidate<Node> => {
    if (candidate.kind === "call" || !names.has(candidate.name)) return candidate
    if (candidate.derivedBy.includes(EXPORT_DEFAULT)) return candidate
    return {
      ...candidate,
      visibility: "public",
      derivedBy: [...candidate.derivedBy, EXPORT_DEFAULT],
    }
  })
}

function readLeadingJsDoc(node: Node): string | null {
  const anchor = outerStatementWrapper(node)
  const collected: string[] = []
  for (let sibling = anchor.previousSibling; sibling !== null; sibling = sibling.previousSibling) {
    if (sibling.type === "decorator") continue
    if (sibling.type !== "comment") break
    if (!sibling.text.startsWith("/**")) continue
    collected.push(sibling.text)
  }
  if (collected.length === 0) return null
  return collected.reverse().join("\n")
}

function outerStatementWrapper(node: Node): Node {
  const ambient = node.parent
  const anchor = ambient?.type === AMBIENT_DECLARATION_TYPE ? ambient : node
  const exported = anchor.parent
  return exported?.type === "export_statement" ? exported : anchor
}
