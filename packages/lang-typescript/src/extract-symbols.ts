import { CoreError } from "@aburi/core"
import type {
  ExtractionContext,
  MergedDeclaration,
  SymbolCandidate,
  SymbolKind,
  Visibility,
} from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import { findChild, makeSourceRange, nameFieldText } from "./ast-helpers"
import {
  type CallExtractionState,
  makeCallExtractionState,
  visitCallStatement,
} from "./call-symbols"
import { readDecorators } from "./decorators"
import { classMemberQname, defaultExportQname, makeTsSymbolId, nestedQname } from "./qname"
import { buildSignature } from "./signature"

/**
 * Refuse to synthesize a placeholder name for a declaration whose grammar node has no
 * name field: doing so would collide every anonymous interface / type alias / enum on
 * the same file id, and the fingerprint pipeline uses Symbol.id as a primary key.
 */
function requireDeclarationName(node: Node, kind: string, file: string): string {
  const name = nameFieldText(node)
  if (name !== null) return name
  throw new CoreError(
    `Missing name field on ${kind} declaration in ${file}:${node.startPosition.row + 1}; the tree-sitter grammar produced an unexpected shape and this plugin refuses to fabricate a placeholder id`,
    { code: "anonymous-symbol-id-attempted", value: `${file}:${kind}` },
  )
}

/**
 * Extract every top-level (and nested-namespace-level) declaration in the tree into a
 * SymbolCandidate. Each returned candidate carries:
 *   - qualified name / core Symbol id
 *   - kind + language-level derivedBy tags
 *   - visibility (export flag / class member accessibility)
 *   - decorators (raw + arguments, boundary defaults to false)
 *   - signature (function-like nodes only)
 *   - the tree-sitter node handle for walkBody / normalizeAst
 *
 * One entity gets one candidate, however many declarations wrote it. TypeScript lets an
 * accessor pair, an overload and its implementation, and a merged interface / namespace all
 * name the same thing, and answering one candidate per *declaration* put two Symbols under
 * one id — which integrity invariant #1 refuses for the whole document, not for the file
 * that wrote it. See `makeCandidateSink` for what the second declaration contributes.
 */
export function extractSymbols(tree: Tree, ctx: ExtractionContext): SymbolCandidate<Node>[] {
  const root = tree.rootNode
  if (root === null) return []
  const out = makeCandidateSink()
  visitModuleLevel(root, ctx, [], out, makeCallExtractionState())
  return out.list()
}

/**
 * Collects candidates under the rule that one entity gets one Symbol.
 *
 * Declarations of an id accumulate in source order and fold at the end. The **leading**
 * declaration gives the Symbol every scalar — kind, visibility, range, signature — and the
 * rest contribute what is list-shaped; here the leader is simply the first, which is what
 * source order already says. TypeScript requires the class or function to precede the
 * namespace merged into it, and requires a merge's declarations to agree on whether they are
 * exported, so the choice is between declarations legal source keeps in agreement.
 *
 * The rule is total rather than a list of the constructs known to need it. A collision this
 * absorbs is not a silent loss: the surviving Symbol carries every declaration's `derivedBy`
 * plus `declaration-merged`, so the merge is readable in the IR — where the alternative was
 * a run that ended with one violation and no document at all.
 */
interface CandidateSink {
  add(candidate: SymbolCandidate<Node>): void
  list(): SymbolCandidate<Node>[]
}

/** Declarations of one entity, in source order. A group exists because something is in it. */
type DeclarationGroup = [SymbolCandidate<Node>, ...SymbolCandidate<Node>[]]

function makeCandidateSink(): CandidateSink {
  const declared = new Map<string, DeclarationGroup>()
  return {
    add(candidate) {
      const group = declared.get(candidate.id)
      if (group === undefined) declared.set(candidate.id, [candidate])
      else group.push(candidate)
    },
    list() {
      return [...declared.values()]
        .map((group) => foldDeclarations(group, group[0]))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
  }
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
  derivedBy.push(MERGED_DECLARATION)
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
    // Tree-sitter attaches decorators as `decorator:` children of the export wrapper. The
    // actual declaration sits on the `declaration:` field; falling back to the first non-
    // decorator, non-comment named child covers grammar shapes that omit the field.
    const declared =
      node.childForFieldName("declaration") ??
      node.namedChildren.find(
        (c): c is Node => c !== null && c.type !== "comment" && c.type !== "decorator",
      )
    if (declared === undefined || declared === null) return
    visitStatement(declared, ctx, namespacePath, out, callState)
    return
  }
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      out.add(makeFunctionCandidate(node, ctx, namespacePath))
      return
    case "function_expression":
    case "arrow_function":
      // Anonymous function forms only become top-level Symbols when they are the target
      // of `export default`. Non-default anonymous expressions live inside another
      // Symbol's body and are covered there.
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
      out.add(makeInterfaceCandidate(node, ctx, namespacePath))
      return
    case "type_alias_declaration":
      out.add(makeTypeAliasCandidate(node, ctx, namespacePath))
      return
    case "enum_declaration":
      out.add(makeEnumCandidate(node, ctx, namespacePath))
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
      // An unexported `namespace` at statement position is parented under an expression
      // statement — measured: every one of them, not only a repeated one and not only after
      // a `}`. Reading through the wrapper is what makes an unexported namespace a
      // declaration at all; without it the statement switch never saw one, and the namespace
      // lost its own Symbol and everything declared inside it.
      const wrapped = wrappedDeclaration(node)
      if (wrapped !== null) {
        visitStatement(wrapped, ctx, namespacePath, out, callState)
        return
      }
      // Namespace-scoped expression statements are extremely rare in TypeScript modules,
      // and the extKind vocabulary that consumes call symbols (framework:express:*) is
      // module-scoped by construction. Only promote calls at the true module top level to
      // keep Symbol.id qnames free of namespace segments that could not have appeared
      // pre-extension.
      if (namespacePath.length !== 0) return
      const candidate = visitCallStatement(node, ctx, callState)
      if (candidate !== null) out.add(candidate)
      return
    }
    default:
      return
  }
}

/**
 * The declaration an expression statement is standing in front of, or null when it really is
 * an expression.
 *
 * Only `internal_module` — the `namespace X {}` spelling — is wrapped this way; the `module
 * X {}` spelling arrives as a bare statement, and so does every other declaration form. The
 * set is a measurement of this grammar rather than a category, so it is written as one.
 */
const WRAPPED_DECLARATION_TYPES: ReadonlySet<string> = new Set(["internal_module"])

function wrappedDeclaration(statement: Node): Node | null {
  if (statement.namedChildCount !== 1) return null
  const only = statement.namedChild(0)
  if (only === null || !WRAPPED_DECLARATION_TYPES.has(only.type)) return null
  return only
}

function addClassAndMembers(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
): void {
  const className = nameFieldText(node)
  const isDefault = isDefaultExport(node)
  // Refuse to fabricate <default> for a class that is neither named nor a default export:
  // this branch used to silently collapse every anonymous class expression to <default>,
  // corrupting the fingerprint pipeline once it reached the top-level walker in error.
  if (className === null && !isDefault) {
    throw new CoreError(
      `Anonymous class at ${ctx.file.path}:${node.startPosition.row + 1} is neither named nor a default export; refusing to synthesize a <default> id`,
      { code: "anonymous-symbol-id-attempted", value: ctx.file.path },
    )
  }
  const qname =
    className !== null ? nestedQname([...namespacePath, className]) : defaultExportQname()
  const derivedBy = collectDerivedBy(node, {
    exportKeyword: hasExportKeywordAncestor(node),
    exportDefault: isDefault,
  })
  const candidate: SymbolCandidate<Node> = {
    id: makeTsSymbolId(currentFile(ctx), qname),
    kind: "class",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(node),
    decorators: readDecorators(node),
    signature: null,
    source: makeSourceRange(node, ctx),
    derivedBy,
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
  out.add(candidate)

  // Members are only walked for named classes. Anonymous default classes
  // (`export default class { m() {} }`) do not have a documented member qname
  // convention in ir-schema.md §3.2 — the `<default>` sentinel is reserved for the
  // class itself, and `<default>.m` violates the identifier-segment pattern the core id
  // builder enforces. Refactor the class to a named form (or export it named separately)
  // to get member Symbols. Deferred alongside the anonymous-scope proposal.
  const body = node.childForFieldName("body")
  if (body === null || className === null) return
  addClassMembers(body, ctx, [...namespacePath, className], out)
}

/**
 * One candidate per member, not per member declaration.
 *
 * `method_signature` is skipped outright: inside a class body it is an overload declaration,
 * and the implementation beside it carries the body and the parameter types the member is
 * actually called with. Top-level overloads have always behaved this way — `function_signature`
 * is absent from the statement switch — and a class has to match, or the same source answers
 * differently depending on where it is written. A class body with signatures and no
 * implementation therefore declares no members, which is what `tsc` calls TS2391 anyway.
 *
 * What is left can still name one member twice: `get v()` beside `set v(n)` is one property,
 * and two `method_definition` nodes. Those fold into one candidate, and the getter is the one
 * that claims it — a property's type is what reading it answers, so taking the setter's
 * signature would report the member as `(n) => void`.
 */
function addClassMembers(
  body: Node,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
  out: CandidateSink,
): void {
  const declared = new Map<string, MemberGroup>()
  for (const member of body.namedChildren) {
    if (member === null || member.type !== "method_definition") continue
    const candidate = makeMethodCandidate(member, ctx, ownerChain)
    if (candidate === null) continue
    const entry: MemberDeclaration = { candidate, isGetter: hasChildOfType(member, "get") }
    const group = declared.get(candidate.id)
    if (group === undefined) declared.set(candidate.id, [entry])
    else group.push(entry)
  }
  for (const group of declared.values()) out.add(foldMemberGroup(group))
}

/** One `method_definition`, with the one thing about it that decides which of a pair leads. */
interface MemberDeclaration {
  candidate: SymbolCandidate<Node>
  isGetter: boolean
}

/** Declarations of one member, in source order. A group exists because something is in it. */
type MemberGroup = [MemberDeclaration, ...MemberDeclaration[]]

function foldMemberGroup(group: MemberGroup): SymbolCandidate<Node> {
  const lead = group.find((member) => member.isGetter) ?? group[0]
  return foldDeclarations(
    group.map((member) => member.candidate),
    lead.candidate,
  )
}

function makeFunctionCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const funcName = nameFieldText(node)
  const isDefault = isDefaultExport(node)
  if (funcName === null && !isDefault) {
    throw new CoreError(
      `Anonymous function at ${ctx.file.path}:${node.startPosition.row + 1} is neither named nor a default export; refusing to synthesize a <default> id`,
      { code: "anonymous-symbol-id-attempted", value: ctx.file.path },
    )
  }
  const qname = funcName !== null ? nestedQname([...namespacePath, funcName]) : defaultExportQname()
  const jsDoc = readLeadingJsDoc(node)
  const signature = buildSignature(node, jsDoc)
  const derivedBy = collectDerivedBy(node, {
    exportKeyword: hasExportKeywordAncestor(node),
    exportDefault: isDefault,
  })
  return {
    id: makeTsSymbolId(currentFile(ctx), qname),
    kind: "function",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(node),
    decorators: readDecorators(node),
    signature,
    source: makeSourceRange(node, ctx),
    derivedBy,
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
}

/**
 * Null for a member whose name is computed (`[Symbol.iterator]() {}`, `["go"]() {}`).
 *
 * The brackets are not a name, and their text used to go into the id builder, which refused
 * it — costing the class and every sibling member as well as the one nobody can name.
 * Normalising the brackets into a segment is refused rather than deferred: any mangling
 * invents a name the source does not contain, two different computed keys can collapse onto
 * one segment, and nothing reads it back to what was written.
 *
 * Silently, and deliberately. A computed name is not a name static analysis can record — the
 * position `lang-plugin.md` LP26e takes on a computed module specifier — so there is nothing
 * to report against the source.
 */
function makeMethodCandidate(
  node: Node,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> | null {
  const kind: SymbolKind = isConstructor(node) ? "constructor" : "method"
  // A constructor cannot reach this: `isConstructor` compares the `name` field's text to
  // "constructor", and a computed name's text carries its brackets.
  if (findChild(node, "computed_property_name") !== null) return null
  // Constructors do not carry a name field in the grammar, so short-circuit before the
  // fail-fast helper would trip on them.
  const methodName =
    kind === "constructor" ? "constructor" : requireDeclarationName(node, "method", ctx.file.path)
  const isStatic = hasChildOfType(node, "static")
  const isPrivateHash = methodName.startsWith("#")
  const qname =
    kind === "constructor"
      ? classMemberQname(ownerChain, "constructor", "instance")
      : classMemberQname(ownerChain, methodName.replace(/^#/, ""), isStatic ? "static" : "instance")
  const jsDoc = readLeadingJsDoc(node)
  const signature = buildSignature(node, jsDoc)
  const visibility: Visibility = isPrivateHash
    ? "private"
    : hasChildOfType(node, "accessibility_modifier")
      ? readAccessibilityKeyword(node)
      : "public"
  const derivedBy: string[] = [isStatic ? "static-method" : "class-method"]
  if (kind === "constructor") derivedBy.push("constructor-declaration")
  // `get` and `set` are anonymous tokens on the same `method_definition` a plain method
  // uses, so nothing else on the Symbol says the member is a property rather than a call.
  if (hasChildOfType(node, "get") || hasChildOfType(node, "set")) {
    derivedBy.push("accessor-declaration")
  }
  return {
    id: makeTsSymbolId(currentFile(ctx), qname),
    kind,
    extKind: null,
    name: qname,
    visibility,
    decorators: readDecorators(node),
    signature,
    source: makeSourceRange(node, ctx),
    derivedBy,
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
}

function makeInterfaceCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const name = requireDeclarationName(node, "interface", ctx.file.path)
  const qname = nestedQname([...namespacePath, name])
  return {
    id: makeTsSymbolId(currentFile(ctx), qname),
    kind: "interface",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(node),
    decorators: [],
    signature: null,
    source: makeSourceRange(node, ctx),
    derivedBy: ["interface-declaration"],
    bodyNode: findChild(node, "object_type") ?? findChild(node, "interface_body"),
    fullNode: node,
  }
}

function makeTypeAliasCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const name = requireDeclarationName(node, "type alias", ctx.file.path)
  const qname = nestedQname([...namespacePath, name])
  return {
    id: makeTsSymbolId(currentFile(ctx), qname),
    kind: "type",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(node),
    decorators: [],
    signature: null,
    source: makeSourceRange(node, ctx),
    derivedBy: ["type-alias"],
    bodyNode: null,
    fullNode: node,
  }
}

function makeEnumCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const name = requireDeclarationName(node, "enum", ctx.file.path)
  const qname = nestedQname([...namespacePath, name])
  return {
    id: makeTsSymbolId(currentFile(ctx), qname),
    kind: "enum",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(node),
    decorators: [],
    signature: null,
    source: makeSourceRange(node, ctx),
    derivedBy: ["enum-declaration"],
    bodyNode: null,
    fullNode: node,
  }
}

/**
 * A namespace declares one Symbol per segment of its name, and its body is visited under all
 * of them.
 *
 * `namespace A.B {}` is sugar for `namespace A { namespace B {} }` and declares both: `A` is
 * addressable after it, so emitting only the innermost would leave a name the file defines
 * with nothing standing for it. Reading the dotted text as one segment is what the id builder
 * refuses — `qualified name "A.B" contains the non-identifier segment "A.B"` — and the throw
 * cost the file every Symbol it had.
 *
 * The intermediate segments share the declaration's range and node with the innermost one,
 * because the source gives them nothing of their own. Two dotted declarations under one head
 * (`namespace A.B {}` beside `namespace A.C {}`) therefore reach the sink as two declarations
 * of `A`, which is what they are.
 */
function addNamespaceAndBody(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
  callState: CallExtractionState,
): void {
  const segments = requireDeclarationName(node, "namespace", ctx.file.path).split(".")
  const path = [...namespacePath]
  for (const segment of segments) {
    path.push(segment)
    const qname = nestedQname(path)
    out.add({
      id: makeTsSymbolId(currentFile(ctx), qname),
      kind: "namespace",
      extKind: null,
      name: qname,
      visibility: computeTopLevelVisibility(node),
      decorators: [],
      signature: null,
      source: makeSourceRange(node, ctx),
      derivedBy: ["namespace-declaration"],
      bodyNode: null,
      fullNode: node,
    })
  }
  const body = node.childForFieldName("body") ?? findChild(node, "statement_block")
  if (body === null) return
  visitModuleLevel(body, ctx, path, out, callState)
}

/**
 * `const f = () => ...` / `const g = function() { ... }` — the arrow / function expression
 * on the right-hand side is treated as a top-level Symbol whose name is the variable
 * binding. Any other value (`const x = 1`) becomes a plain `const` Symbol whose signature
 * is null.
 *
 * A destructuring declaration (`const { GET, POST } = handlers`) declares one binding per
 * name in the pattern, so it produces one Symbol each — which is why this answers a list.
 * Reading the pattern's text as a name instead put `{ GET, POST }` into the id builder,
 * which refused it, and the throw cost the file every Symbol it had.
 */
function makeVariableCandidates(
  declarator: Node,
  parent: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node>[] {
  const nameNode = declarator.childForFieldName("name")
  if (nameNode !== null && isBindingPattern(nameNode)) {
    return collectPatternBindings(nameNode).map((binding) =>
      makeDestructuredCandidate(binding, parent, ctx, namespacePath),
    )
  }
  const single = makeVariableCandidate(declarator, parent, ctx, namespacePath)
  return single === null ? [] : [single]
}

function makeVariableCandidate(
  declarator: Node,
  parent: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> | null {
  const name = nameFieldText(declarator)
  if (name === null) return null
  const value = declarator.childForFieldName("value")
  const qname = nestedQname([...namespacePath, name])
  const id = makeTsSymbolId(currentFile(ctx), qname)
  if (value !== null && (value.type === "arrow_function" || value.type === "function_expression")) {
    const jsDoc = readLeadingJsDoc(parent)
    const signature = buildSignature(value, jsDoc)
    const derivedBy: string[] = ["variable-assigned-function"]
    if (hasExportKeywordAncestor(parent)) derivedBy.push("export-keyword")
    return {
      id,
      kind: "function",
      extKind: null,
      name: qname,
      visibility: computeTopLevelVisibility(parent),
      decorators: [],
      signature,
      source: makeSourceRange(parent, ctx),
      derivedBy,
      bodyNode: value.childForFieldName("body"),
      fullNode: value,
    }
  }
  return {
    id,
    kind: "const",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(parent),
    decorators: [],
    signature: null,
    source: makeSourceRange(parent, ctx),
    derivedBy: hasExportKeywordAncestor(parent) ? ["export-keyword"] : [],
    bodyNode: null,
    fullNode: parent,
  }
}

/** The two shapes a `variable_declarator` uses in place of a name. */
function isBindingPattern(node: Node): boolean {
  return node.type === "object_pattern" || node.type === "array_pattern"
}

/**
 * Every identifier a destructuring pattern *binds*, in source order.
 *
 * The distinction the walk has to keep is between a name being bound and a name being read.
 * `{ a: b }` binds `b` and names the property `a` on the value; `{ a = fallback }` binds `a`
 * and reads `fallback` from somewhere else entirely. Collecting every identifier under the
 * pattern would declare Symbols for both of those, so each wrapper is entered through the one
 * field that holds a binding rather than through its children.
 *
 * Which makes the *set of wrappers* the thing that has to be right, and a missing one silent
 * — so an unmodelled node type is refused rather than passed over. An array hole (`[, x]`)
 * binds nothing and is not a named child, so it needs no case; a `comment` is a named child
 * and gets one.
 */
function collectPatternBindings(pattern: Node): Node[] {
  const out: Node[] = []
  const visit = (node: Node): void => {
    switch (node.type) {
      case "identifier":
      case "shorthand_property_identifier_pattern":
        out.push(node)
        return
      case "object_pattern":
      case "array_pattern":
        for (const child of node.namedChildren) {
          if (child !== null) visit(child)
        }
        return
      case "pair_pattern": {
        // The key is a `property_identifier`, a `string`, a `number` or a
        // `computed_property_name` depending on how it was written, and none of them is a
        // declaration. Reading the `value` field says so rather than filtering them out.
        const value = node.childForFieldName("value")
        if (value !== null) visit(value)
        return
      }
      // Two node types for one idea: the grammar uses `object_assignment_pattern` for an
      // object shorthand default (`{ a = 1 }`) and `assignment_pattern` for every other
      // default — an array element (`[a = 1]`) and a renamed property (`{ z: a = 1 }`).
      // Covering only the first bound nothing at all for the other two.
      case "assignment_pattern":
      case "object_assignment_pattern": {
        // `left` is the binding; `right` is a default expression evaluated elsewhere.
        const left = node.childForFieldName("left") ?? node.namedChild(0)
        if (left !== null) visit(left)
        return
      }
      case "rest_pattern": {
        const inner = node.namedChild(0)
        if (inner !== null) visit(inner)
        return
      }
      case "comment":
        // A named child of both pattern kinds, and the one thing inside a pattern that
        // legitimately binds nothing.
        return
      default:
        // Loud, because the alternative is the failure this whole change is about. A node
        // type this walk does not model binds nothing here, which is indistinguishable from
        // a pattern that declares nothing — and a binding lost that way leaves no Symbol, no
        // diagnostic and no `skipped` entry. `assignment_pattern` went missing exactly this
        // way. Refusing sends the file to the per-file boundary instead, which names it.
        throw new CoreError(
          `Unmodelled node "${node.type}" inside a destructuring pattern at ${pattern.startPosition.row + 1}; refusing to report bindings this walk may have missed`,
          { code: "anonymous-symbol-id-attempted", value: node.type },
        )
    }
  }
  visit(pattern)
  return out
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
  parent: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const qname = nestedQname([...namespacePath, binding.text])
  const derivedBy = ["destructured-binding"]
  if (hasExportKeywordAncestor(parent)) derivedBy.push("export-keyword")
  return {
    id: makeTsSymbolId(currentFile(ctx), qname),
    kind: "const",
    extKind: null,
    name: qname,
    visibility: computeTopLevelVisibility(parent),
    decorators: [],
    signature: null,
    source: makeSourceRange(parent, ctx),
    derivedBy,
    bodyNode: null,
    fullNode: parent,
  }
}

function collectDerivedBy(
  _node: Node,
  flags: { exportKeyword: boolean; exportDefault: boolean },
): string[] {
  const out: string[] = []
  if (flags.exportDefault) out.push("export-default")
  else if (flags.exportKeyword) out.push("export-keyword")
  return out
}

function computeTopLevelVisibility(node: Node): Visibility {
  return hasExportKeywordAncestor(node) || isDefaultExport(node) ? "public" : "internal"
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

function hasChildOfType(node: Node, typeName: string): boolean {
  for (const child of node.children) {
    if (child !== null && child.type === typeName) return true
  }
  return false
}

function isConstructor(node: Node): boolean {
  const name = node.childForFieldName("name")
  return name !== null && name.text === "constructor"
}

function isDefaultExport(node: Node): boolean {
  const parent = node.parent
  if (parent === null || parent.type !== "export_statement") return false
  for (const child of parent.children) {
    if (child !== null && child.type === "default") return true
  }
  return false
}

function hasExportKeywordAncestor(node: Node): boolean {
  const parent = node.parent
  return parent !== null && parent.type === "export_statement"
}

function currentFile(ctx: ExtractionContext): string {
  return ctx.file.path
}

/**
 * Read the JSDoc blocks written above a declaration, joined in source order, or `null` when
 * there are none. Only `/**`-opening comments count — an ordinary `/* … *\/` block and a `//`
 * line are not documentation, and the one consumer of this string (`readThrows`, which scans
 * it for `@throws`) has no way to tell them apart once they are in it.
 *
 * That distinction is what keeps the run safe now that it steps over decorators. The space
 * between a decorator and its member is where `// biome-ignore`, ticket references and
 * commented-out decorators are written, and a `@throws` mentioned in one of those is prose
 * about the code, not a declaration of what the member throws.
 *
 * Wrapper handling: if the declaration is inside an `export_statement` (`export function
 * f() {}`), the JSDoc lives before the export wrapper, not before the declaration itself.
 * Walk up to the outermost wrapper before scanning siblings.
 *
 * The scan walks backwards from the anchor rather than reading the parent's child list and
 * searching it for the anchor's own position — see lang-plugin.md §8.2 for why a per-node
 * question has to be asked of the node: at module level that list is every statement in the
 * file, and materializing it once per declaration is what made a large single file
 * quadratic.
 *
 * What the walk does at each kind of sibling:
 *
 * - a `/**` comment is **collected**;
 * - any other comment, and a decorator, is **stepped over**. A decorator belongs to the
 *   member rather than separating anything from it (`/** doc *\/ @Get() handler() {}` is
 *   idiomatic), and a note written among them does not detach the block above it either;
 * - anything else **ends the run**, including an anonymous token. A stray `;` in a class body
 *   separates a comment from the member below it, and reading past one would hand that
 *   member a block written about nothing.
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
  const parent = node.parent
  if (parent !== null && parent.type === "export_statement") return parent
  return node
}
