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

/**
 * Collects candidates under the rule that one entity gets one Symbol.
 *
 * Declarations of an id accumulate in source order and fold at the end. The **leading**
 * declaration gives the Symbol every scalar — kind, visibility, range, signature — and the
 * rest contribute what is list-shaped; here the leader is the first declaration that is not an
 * overload signature (`leadOf`), so an overload set is led by its implementation and anything
 * else by what source order already says. TypeScript requires the class or function to precede
 * a namespace merged into it once that namespace holds a value (TS2434), and requires a merge's
 * declarations to agree on whether they are exported, so the choice is between declarations
 * legal source keeps in agreement. A namespace holding only types may come first, and then it
 * leads.
 *
 * A value and a type share one qualified name, so they fold too: `const X` beside `type X`, or
 * a static `m` beside a merged namespace's `export type m`, is one Symbol led by whichever is
 * written first.
 *
 * The rule is total rather than a list of the constructs known to need it. A collision this
 * absorbs is not a silent loss: the surviving Symbol carries every declaration's `derivedBy`
 * plus `declaration-merged`, so the merge is readable in the IR — where the alternative was
 * a run that ended with one violation and no document at all.
 *
 * One group is dropped, and silently: overload signatures with nothing beside them that can
 * lead, which `tsc` rejects as TS2391. No declaration in it carries a body or the parameter
 * types the function is called with, so there is no Symbol to give it, and no drop reason says
 * so — the answer each such signature got while it was skipped on its own. An overload written
 * beside some other declaration of its name, a namespace say, folds into that one's Symbol.
 */
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

/**
 * The declaration that leads a group: the first one that is not an overload signature, or null
 * when every one is.
 *
 * An overload signature (`function parse(input: string): Config;` outside a `declare`, or a
 * `method_signature` in an ordinary class body) is written ahead of its implementation, but the
 * implementation carries the body and the parameter types the function is actually called with,
 * so it leads (LP8f). The overloads still fold in, as declarations with no body, so the syntax
 * axis sees them (LP8q). Dropped, they reached no fingerprint of the Symbol they belong to: an
 * edit to a method's overload moved only its class's `syntax`, whose body serializes every
 * member, and one to a module-level overload moved nothing. A group of overloads and nothing
 * else is TS2391, and stays without a Symbol, as before.
 *
 * The rule runs at **two levels**: `foldMemberGroup` applies it to one class member's
 * declarations, and the sink applies it again to everything with that member's id — which by
 * then is the member Symbol already folded. The sink cannot tell an already-decided Symbol from
 * a raw declaration, since it reads the lead's `fullNode` either way, so a member Symbol led by
 * an overload reads as a group of overloads and is dropped, body and all. That is why
 * `foldMemberGroup` never lets an overload lead, whatever else would.
 */
function leadOf(group: readonly SymbolCandidate<Node>[]): SymbolCandidate<Node> | null {
  return group.find((declaration) => !isOverloadSignature(declaration.fullNode)) ?? null
}

/**
 * A bodyless function or method declaration an implementation can be written beside. Under a
 * `declare` nothing can be, so the signature is the declaration (LP36); an
 * `abstract_method_signature` is not one either, since the language forbids an implementation
 * beside it (LP35).
 */
function isOverloadSignature(node: Node): boolean {
  return (
    (node.type === "function_signature" || node.type === "method_signature") &&
    !inAmbientContext(node)
  )
}

/** Rationale recorded on a Symbol more than one declaration wrote. */
const MERGED_DECLARATION = "declaration-merged"

/**
 * Fold every declaration of one entity into the Symbol `lead` heads: scalars are the lead's,
 * lists are joined **in source order**, and each other declaration's nodes are carried so the
 * body walk and the fingerprint can see the whole entity.
 *
 * Both nodes are carried, not just the body. A declaration with no body — an enum, a type
 * alias, a namespace whose statements are their own Symbols — is described by its `fullNode`,
 * which is where `normalizeAst` already looks when a Symbol has no body. Carrying only bodies
 * made a reopened `enum E {}` fingerprint identically to the first declaration alone, so
 * adding, editing or deleting the second changed nothing. Only the bodies reach `walkBody`,
 * which is what keeps a merged namespace from being walked twice — once here and once through
 * the member Symbols its statements already produce.
 *
 * Decorators are joined rather than kept from the lead, because dropping one changes what the
 * Symbol *is*: `interface P {}` beside `@Controller() class P {}` is legal with the interface
 * written first, so the lead is the declaration carrying no decorators, and a lost `boundary`
 * decorator turns a controller into an `interface (data model)` drop.
 *
 * `declaration-merged` is said once, like every other token. A declaration can be a fold
 * already — a class member whose accessor pair or overloads `foldMemberGroup` joined, meeting
 * a merged namespace's export of the same id here — and it then brings the token with it.
 */
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
      // A bodyless `function_signature` is added like any function, and the sink decides what
      // it is. Under a `declare` there are no implementations, so the signature is the whole
      // declaration and leads (skipping it left `declare function f(): void` extracting
      // nothing). Outside one it is an overload, which folds into the implementation's Symbol as
      // a declaration with no body and never leads it (`leadOf`, LP8q).
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

/**
 * One candidate per member, not per member declaration. Which class-body nodes declare a
 * member at all, an overload `method_signature` among them, is `memberSymbolSegment`'s answer;
 * which of a member's declarations leads it is `foldMemberGroup`'s.
 *
 * So one member can be written more than once: `get v()` beside `set v(n)` is one property,
 * and two `method_definition` nodes, and `find(id: string): User;` beside `find(id: any) { … }`
 * is one method (LP8q). Those fold into one candidate. Of an accessor pair the getter is the
 * one that claims it — a property's type is what reading it answers, so taking the setter's
 * signature would report the member as `(n) => void` — and of an overload set, the
 * implementation.
 *
 * A field holding a function is a member here too, and folds by id with the rest: a field
 * and a method of the same name are one id, which is what `tsc` calls TS2300 anyway.
 */
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

/**
 * One member's declarations as one candidate, or null when none of them can lead.
 *
 * An overload never leads, and that is decided before the getter rule rather than after it.
 * `get x(): number;` outside a `declare` is an overload signature that is also a getter, and
 * the sink runs `leadOf` again on what this returns: a member led by that signature would read
 * there as a group of overloads and lose its Symbol, while the walk still skipped the body of
 * the `set x(v) { … }` beside it, expecting the member's Symbol to carry it. So the getter rule
 * picks among the declarations that can lead, and a member of overloads alone has none.
 */
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

/**
 * One class-member declaration `memberSymbolSegment` has already admitted — an overload
 * signature included, which becomes a candidate here and folds into its implementation's — and
 * the segment it admitted it by: a member whose name has no qualified-name segment — computed,
 * quoted into something that is not an identifier, numeric — never reaches here, and the name
 * is not read a second time.
 *
 * Taking the segment as an argument is what leaves no way for this to refuse a name. Reading
 * the name here instead would mean handing its text to the id builder, which throws on
 * anything that is not an identifier and costs the file at the per-file boundary.
 */
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

/**
 * One binding out of a destructuring declaration.
 *
 * `const` and not `function`, even when the initializer is an object of arrows: pairing a
 * pattern key with an object-literal property is analysis this plugin does nowhere else, and
 * claiming a kind on a guess would make the two paths disagree about what evidence a kind
 * needs. The `source` range is the whole declaration, as it is for a plain `const` — several
 * Symbols therefore share one range, and `destructured-binding` is what tells a reader why.
 *
 * `fullNode` is the declaration too, so every binding out of one statement normalizes to the
 * same AST string and carries the same syntax fingerprint. Intended, and not new: `const a =
 * 1, b = 2` has done it since before this walk existed. What it costs is precision in the
 * diff's rename similarity, which compares that fingerprint — two bindings from one
 * declaration look alike to it, which for a destructuring is closer to true than not.
 */
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

/**
 * The JSDoc blocks written above a declaration, joined in source order, or `null` when there
 * are none. Only `/**`-opening comments count. Any other comment is a note about the code rather
 * than its documentation, and the space between a decorator and its member is where
 * `// biome-ignore` notes and commented-out decorators are written. Once the text is joined,
 * `readThrows` cannot tell which kind of comment a `@throws` came from, and its rule against
 * reading a description as a type does not stand in for that: `// @throws Legacy` is a type name
 * by that rule, and would be recorded.
 *
 * The scan starts at the outermost wrapper (`export`, `declare`), since that is where the
 * JSDoc sits, and walks backwards from the anchor rather than searching the parent's child
 * list — at module level that list is every statement in the file, and materializing it once
 * per declaration made a large single file quadratic (`lang-plugin.md`). A decorator and
 * a non-doc comment are stepped over; anything else ends the run, including an anonymous
 * token such as a stray `;`, which separates a comment from the member below it.
 */
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
