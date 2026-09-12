import { CoreError } from "@aburi/core"
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
  findChild,
  firstNonCommentChild,
  functionValueOf,
  hasChildOfType,
  inAmbientContext,
  makeSourceRange,
  nameFieldText,
  statementParent,
  unwrapValue,
} from "./ast-helpers"
import {
  type CallExtractionState,
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
 *
 * A last pass links each `export default <identifier>` statement back to the declaration it
 * names: written apart from its declaration, that export leaves no evidence on the
 * declaration node for the walk to read. Export clauses (`export { Page }`, `export { Page as
 * default }`) are the same shape and stay unread. See `promoteDefaultExports`.
 */
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
  if (node.type === AMBIENT_DECLARATION_TYPE) {
    const declared = ambientDeclaration(node)
    if (declared === null) return
    visitStatement(declared, ctx, namespacePath, ambientSink(out), callState)
    return
  }
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      out.add(makeFunctionCandidate(node, ctx, namespacePath))
      return
    case "function_signature":
      // A bodyless function is a Symbol only where nothing can be written beside it to carry
      // the body. At module level it is an overload declaration and the implementation below it
      // is the Symbol; under a `declare` there are no implementations, so the signature is the
      // whole declaration and skipping it left `declare function f(): void` extracting nothing.
      if (inAmbientContext(node)) out.add(makeFunctionCandidate(node, ctx, namespacePath))
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

/**
 * The declaration a `declare` was written on, or null when the `declare` declares nothing *in
 * this module*.
 *
 * `declare` is a modifier the grammar spells as a wrapper, and every form goes through it:
 * `declare function f(): void`, `declare class C {}`, `declare const x: number`, `declare
 * namespace N {}`, `declare enum E {}`, `declare interface I {}`, `declare type T = …`. So the
 * wrapper is read through rather than matched on, and each of those reaches the arm of the
 * statement switch it would have reached written without the keyword — which is what the
 * `export declare class C {}` in every ordinary `.ts` file needs, `.d.ts` files being dropped
 * before extraction (Category A) while these are not.
 *
 * `declare global { … }` is the one form holding a bare `statement_block` rather than a
 * declaration, and it is refused. It augments the **global** scope: `interface Window { … }`
 * inside it declares a member of that scope, not of this file, and the only qualified name this
 * plugin could give it is a top-level one — where it would claim the name for this module and
 * fold with the file's own declaration of it (§4.3.1). `declare module "express" { … }` is the
 * same construct aimed at another module and is refused on the same ground, one step further in
 * (see `declaredNamespaceName`). Both are a known limit rather than an oversight: giving either its
 * Symbols needs a qname convention for a scope that is not the file's, which `ir-schema.md` §3.2
 * does not have.
 */
function ambientDeclaration(node: Node): Node | null {
  const inner = firstNonCommentChild(node)
  if (inner === null || inner.type === "statement_block") return null
  return inner
}

/** What `derivedBy` says when a Symbol was declared under a `declare`. */
const AMBIENT_DECLARATION = "ambient-declaration"

/**
 * `out`, with every candidate reaching it marked as written under a `declare`.
 *
 * The token is stamped on the sink rather than by each builder because `declare` wraps a
 * *statement*, and everything that statement declares in turn is ambient too — a `declare
 * namespace`'s functions and nested classes, a `declare class`'s methods. Wrapping the sink is
 * what makes that one rule instead of an argument every declaration builder has to remember to
 * forward, and it cannot drift from the wrapper that established it.
 *
 * The stamp is idempotent, because the wrapping is not. `declare namespace N { declare function
 * g(): void }` is TS1038 and the grammar accepts it with no error at all, so the ambient arm is
 * taken on the way in and again on the inner statement — and `g` came out carrying the token
 * twice. Nothing downstream would have removed it: `foldDeclarations` dedupes only across an
 * entity's several declarations, and the core pipeline's `mergeDerivedBy` only across what
 * frameworks contribute.
 *
 * `list` is the wrapped sink's, so folding and ordering still happen once, over every
 * declaration in the file (§4.3.1). An ambient declaration merged with a non-ambient one keeps
 * the token, which is what the fold does with every other `derivedBy`.
 */
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
  addClassMembers(node, body, ctx, [...namespacePath, className], out)
}

/**
 * One candidate per member, not per member declaration.
 *
 * `method_signature` is skipped in an ordinary class body: there it is an overload declaration,
 * and the implementation beside it carries the body and the parameter types the member is
 * actually called with. Top-level overloads behave the same way — a bare `function_signature`
 * is not a Symbol either — and a class has to match, or the same source answers differently
 * depending on where it is written. A class body with signatures and no implementation therefore
 * declares no members, which is what `tsc` calls TS2391 anyway. Under a `declare` the reading
 * inverts, because no implementation can be written beside them at all; `memberSymbolSegment`
 * owns that split, along with the `abstract_method_signature` a class body admits outright.
 *
 * What is left can still name one member twice: `get v()` beside `set v(n)` is one property,
 * and two `method_definition` nodes. Those fold into one candidate, and the getter is the one
 * that claims it — a property's type is what reading it answers, so taking the setter's
 * signature would report the member as `(n) => void`.
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
  const declared = new Map<string, MemberGroup>()
  for (const member of body.namedChildren) {
    if (member === null) continue
    const segment = memberSymbolSegment(classNode, member)
    if (segment === null) continue
    // Which of the two member shapes this is. A field the predicate admitted always answers
    // with the function it holds, and a `method_definition` falls out on one type test.
    const fieldFunction = functionValuedField(member)
    const candidate =
      fieldFunction === null
        ? makeMethodCandidate(member, segment, ctx, ownerChain)
        : makeFieldFunctionCandidate(member, fieldFunction, segment, ctx, ownerChain)
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
 * One class member `memberSymbolSegment` has already admitted, and the segment it admitted it
 * by: a member whose name has no qualified-name segment — computed, quoted into something that
 * is not an identifier, numeric — never reaches here, and the name is not read a second time.
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
  // The member is declared and not implemented here, by the `abstract` modifier rather than by
  // being an empty stub. Nothing else on the Symbol says so: an abstract member and a `declare`d
  // one both arrive with a null `bodyNode`, which is also what a half-written method has.
  if (node.type === "abstract_method_signature") derivedBy.push(ABSTRACT_DECLARATION)
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

/**
 * A class field whose value is a function, which `memberSymbolSegment` has already admitted —
 * `value` is the function `functionValuedField` answered with and `segment` is the name it was
 * admitted by, so nothing is re-derived here.
 *
 * `kind` is `method` rather than `function`: the Symbol is a member of a class, named by the
 * member convention, and every reader that asks what a class member is gets one answer
 * whichever way the member was written. `derivedBy` is where the difference is recorded.
 *
 * The signature is the function's, not the field's type annotation. `create: Handler = (d) =>
 * …` writes the parameter names once, in the arrow; the annotation names a type.
 */
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
    id: makeTsSymbolId(currentFile(ctx), qname),
    kind: "method",
    extKind: null,
    name: qname,
    visibility: memberVisibility(field),
    decorators: readDecorators(field),
    signature: buildSignature(value, jsDoc),
    // The field's range, not the function's: the member is declared where it is written, and a
    // field's modifiers, decorator and type annotation are all outside the arrow. Which makes
    // this wider than a decorated *method*'s range, where the grammar puts the decorator
    // outside the member — one member spelled two ways, reported over two spans.
    source: makeSourceRange(field, ctx),
    derivedBy: fieldDerivedBy(field, isStatic),
    bodyNode: value.childForFieldName("body"),
    fullNode: value,
  }
}

/**
 * How a field-written member was declared. `accessor` makes it an auto-accessor — a
 * getter/setter pair over a hidden field — so it earns the same token `get v()` does, or
 * nothing downstream can tell the pair from a plain field holding a function.
 */
function fieldDerivedBy(field: Node, isStatic: boolean): string[] {
  const out = [isStatic ? "static-method" : "class-method", "field-assigned-function"]
  if (hasChildOfType(field, "accessor")) out.push("accessor-declaration")
  return out
}

/**
 * A member's visibility, from the two ways a class body writes it: a `#` name is private to the
 * language, an `accessibility_modifier` is private or protected to the type checker. No modifier
 * is `public`, which is what `readAccessibilityKeyword` answers when it finds none — the same
 * answer `public m() {}` gets, and the reason this needs no third branch.
 */
function memberVisibility(member: Node): Visibility {
  return hasPrivateName(member) ? "private" : readAccessibilityKeyword(member)
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
 * The dotted name a namespace declaration gives its Symbols, or null when what it names is not
 * a namespace of **this** module.
 *
 * Three shapes answer null, and each of them would otherwise put something in the IR that the
 * source does not contain — or take the file down on the way.
 *
 * - **A name the parser invented.** `declare namespace` with nothing after it recovers as an
 *   `internal_module` whose name is a MISSING `identifier` of no width. Read as an absent name
 *   it reaches `requireDeclarationName`, which throws, and the throw reaches the per-file
 *   boundary — withdrawing the whole file and with it the recoverable parse errors that were
 *   the one diagnostic pointing at the missing token. `isMissing` is what says the parser
 *   guessed, the same question `hasErrorChild` asks of a written member name.
 * - **A quoted specifier** — `declare module "express" { … }`, `module "express" {}`. It
 *   augments another module, so the declarations inside it are members of *that* module. A
 *   specifier is not a qualified-name segment (handing `"express"` to the id builder throws,
 *   §4.3), and the declarations under it would have to take bare top-level qnames, claiming
 *   another module's names for this file and folding with its own declarations of them
 *   (§4.3.1). The `declare` is the grammar's business and not `tsc`'s: this arm parses the
 *   quoted spelling written without one, so the throw was live before the wrapper was read
 *   through rather than arriving with it.
 * - **No body.** `declare module` followed by `export function keep() {}` on the next line
 *   parses with no error at all — `export` becomes the module's name. It satisfies the
 *   qualified-name grammar, so a namespace called `export` entered the IR with no diagnostic
 *   and the diff reported it as added. A namespace with no body declares nothing in any
 *   spelling, so refusing it costs nothing.
 *
 * What is left is *read* rather than type-tested, because `namespace A.B {}` carries a
 * `nested_identifier` where `namespace A {}` carries an `identifier` — admitting only the
 * latter would refuse the dotted form LP8l exists for.
 */
function declaredNamespaceName(node: Node, body: Node | null): string | null {
  if (body === null) return null
  const name = node.childForFieldName("name")
  if (name === null || name.isMissing || name.type === "string") return null
  return name.text.length > 0 ? name.text : null
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
 *
 * A declaration `declaredNamespaceName` refuses declares nothing at all: no Symbol for the
 * namespace, and no walk of a body it does not have.
 */
function addNamespaceAndBody(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
  callState: CallExtractionState,
): void {
  const body = node.childForFieldName("body") ?? findChild(node, "statement_block")
  const declared = declaredNamespaceName(node, body)
  if (declared === null || body === null) return
  const segments = declared.split(".")
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
  const value = functionValueOf(declarator)
  const qname = nestedQname([...namespacePath, name])
  const id = makeTsSymbolId(currentFile(ctx), qname)
  if (value !== null) {
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
  if (flags.exportDefault) out.push(EXPORT_DEFAULT)
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

function isDefaultExport(node: Node): boolean {
  const parent = statementParent(node)
  if (parent === null || parent.type !== "export_statement") return false
  return hasDefaultKeyword(parent)
}

/** The `default` an `export_statement` is written with, which the grammar leaves anonymous. */
function hasDefaultKeyword(statement: Node): boolean {
  for (const child of statement.children) {
    if (child !== null && child.type === "default") return true
  }
  return false
}

/** What `derivedBy` says when a Symbol is the module's default export. */
const EXPORT_DEFAULT = "export-default"

/**
 * Every name the module hands to `export default`, read through the wrappers that say
 * nothing about the value.
 *
 * `export default Page` is a statement of its own rather than a wrapper around a
 * declaration, so nothing on the declaration node says that the declaration is exported —
 * `isDefaultExport` reads the parent, and the parent of `const Page = () => …` is the
 * module. The two are linked by name or not at all, which is why the names are collected up
 * front: one pass over the module's own statements, asked once, instead of a search of the
 * module per declaration (`lang-plugin.md` §8.2).
 *
 * The wrappers are read by `unwrapValue`, the one reader that answers what a wrapper is for
 * every question this plugin asks about a node (LP7a). `export default Page satisfies NextPage`
 * is an ordinary spelling, and a `satisfies`, an `as`, a `!` and a parenthesis all leave the
 * value exactly the declaration it names — so a framework reading `export-default` does not
 * depend on which of them was written, which is the whole of what LP6a promises.
 *
 * What the unwrap stops at is what is not a reference to a declaration: `export default
 * withAuth(Page)` is a call, where LP7b draws the line — it returns a value by convention and
 * nothing in the tree says so; `export default { Page }` and `export default Routes.Page` are
 * a value the module builds and a member of one, neither of which is the declaration; and
 * `export { Page as default }` is an export clause, a form this plugin does not yet read for
 * visibility in any of its spellings.
 */
function defaultExportedNames(root: Node): ReadonlySet<string> {
  const names = new Set<string>()
  for (const stmt of root.namedChildren) {
    if (stmt === null || stmt.type !== "export_statement") continue
    if (!hasDefaultKeyword(stmt)) continue
    const value = stmt.childForFieldName("value")
    if (value === null) continue
    const inner = unwrapValue(value)
    if (inner.type !== "identifier") continue
    names.add(inner.text)
  }
  return names
}

/**
 * Hand the declaration a separate `export default` names the boundary and the visibility the
 * export puts on it.
 *
 * `const Page = () => …` followed by `export default Page` is an ordinary way to write a React
 * component, and reported without this it was `internal` and carried no `export-default` —
 * which is what the Next.js plugin reads to find the page, layout or route a file is. So the
 * same component reported itself as an internal helper when it was written this way and as a
 * public page boundary when it was written `export default function Page()`, on files the
 * framework treats identically.
 *
 * Matching is by qualified name against the module's top-level names. A class member named
 * `Page` (`Shell.Page`, or `Shell::Page` when it is static) and a namespaced declaration
 * (`Routes.Page`) carry a segment separator that no bare identifier can spell, so neither can
 * be reached by accident; an identifier naming an import rather than a declaration matches
 * nothing at all.
 *
 * A **call** Symbol (LP20g) is the one qname that could collide: it is a single segment of
 * identifier-legal characters (`app__get__$users__d0`), so a module exporting an identifier
 * spelled exactly that way would otherwise promote it. Nobody writes that name, but a
 * registration statement is not a declaration an `export default <identifier>` can be naming,
 * so the kind is refused rather than left to the spelling.
 */
function promoteDefaultExports(
  candidates: SymbolCandidate<Node>[],
  names: ReadonlySet<string>,
): SymbolCandidate<Node>[] {
  if (names.size === 0) return candidates
  return candidates.map((candidate): SymbolCandidate<Node> => {
    if (candidate.kind === "call" || !names.has(candidate.name)) return candidate
    // Legal source cannot reach this: a declaration carrying `export default` itself has no
    // `value` field for `defaultExportedNames` to read, so a module that reaches here at all
    // wrote a *second* `export default` (TS2528). The grammar accepts the half-edited file
    // either way, and a Symbol claiming the same evidence twice is not an answer this plugin
    // should give about any input.
    if (candidate.derivedBy.includes(EXPORT_DEFAULT)) return candidate
    return {
      ...candidate,
      visibility: "public",
      derivedBy: [...candidate.derivedBy, EXPORT_DEFAULT],
    }
  })
}

function hasExportKeywordAncestor(node: Node): boolean {
  const parent = statementParent(node)
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
 * f() {}`) or an `ambient_declaration` (`declare function f(): void`), or both (`export declare
 * function f(): void`), the JSDoc lives before the outermost wrapper rather than before the
 * declaration itself. Walk up to that wrapper before scanning siblings.
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

/**
 * The outermost wrapper a declaration's JSDoc is written above: the `export_statement` around
 * an `ambient_declaration` around the declaration, or whichever of those two the source wrote.
 *
 * It reads the same wrappers `statementParent` does and cannot simply call it, because it needs
 * a different answer — the wrapper *node*, to scan backwards from, rather than what is above it.
 * The two agree about which wrappers exist, and nothing enforces that they keep agreeing: a
 * third wrapper would have to be added to both.
 */
function outerStatementWrapper(node: Node): Node {
  const ambient = node.parent
  const anchor = ambient?.type === AMBIENT_DECLARATION_TYPE ? ambient : node
  const exported = anchor.parent
  return exported?.type === "export_statement" ? exported : anchor
}
