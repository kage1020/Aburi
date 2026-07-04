import { CoreError } from "@aburi/core"
import type {
  ExtractionContext,
  Symbol as IRSymbol,
  SymbolCandidate,
  SymbolKind,
  Visibility,
} from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import { findChild, nameFieldText } from "./ast-helpers"
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
 */
export function extractSymbols(tree: Tree, ctx: ExtractionContext): SymbolCandidate<Node>[] {
  const out: SymbolCandidate<Node>[] = []
  const root = tree.rootNode
  if (root === null) return out
  visitModuleLevel(root, ctx, [], out)
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

function visitModuleLevel(
  parent: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: SymbolCandidate<Node>[],
): void {
  for (const stmt of parent.namedChildren) {
    if (stmt === null) continue
    visitStatement(stmt, ctx, namespacePath, out)
  }
}

function visitStatement(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: SymbolCandidate<Node>[],
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
    visitStatement(declared, ctx, namespacePath, out)
    return
  }
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      out.push(makeFunctionCandidate(node, ctx, namespacePath))
      return
    case "function_expression":
    case "arrow_function":
      // Anonymous function forms only become top-level Symbols when they are the target
      // of `export default`. Non-default anonymous expressions live inside another
      // Symbol's body and are covered there.
      if (isDefaultExport(node)) {
        out.push(makeFunctionCandidate(node, ctx, namespacePath))
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
      out.push(makeInterfaceCandidate(node, ctx, namespacePath))
      return
    case "type_alias_declaration":
      out.push(makeTypeAliasCandidate(node, ctx, namespacePath))
      return
    case "enum_declaration":
      out.push(makeEnumCandidate(node, ctx, namespacePath))
      return
    case "internal_module":
    case "module":
    case "namespace_declaration":
      addNamespaceAndBody(node, ctx, namespacePath, out)
      return
    case "lexical_declaration":
    case "variable_declaration":
      for (const declarator of node.namedChildren) {
        if (declarator === null || declarator.type !== "variable_declarator") continue
        const candidate = makeVariableCandidate(declarator, node, ctx, namespacePath)
        if (candidate !== null) out.push(candidate)
      }
      return
    default:
      return
  }
}

function addClassAndMembers(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: SymbolCandidate<Node>[],
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
  out.push(candidate)

  // Members are only walked for named classes. Anonymous default classes
  // (`export default class { m() {} }`) do not have a documented member qname
  // convention in ir-schema.md §3.2 — the `<default>` sentinel is reserved for the
  // class itself, and `<default>.m` violates the identifier-segment pattern the core id
  // builder enforces. Refactor the class to a named form (or export it named separately)
  // to get member Symbols. Deferred to v0.2 alongside the anonymous-scope proposal.
  const body = node.childForFieldName("body")
  if (body === null || className === null) return
  const ownerChain = [...namespacePath, className]
  for (const member of body.namedChildren) {
    if (member === null) continue
    if (member.type === "method_definition" || member.type === "method_signature") {
      out.push(makeMethodCandidate(member, ctx, ownerChain))
    }
  }
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

function makeMethodCandidate(
  node: Node,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> {
  const kind: SymbolKind = isConstructor(node) ? "constructor" : "method"
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

function addNamespaceAndBody(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: SymbolCandidate<Node>[],
): void {
  const name = requireDeclarationName(node, "namespace", ctx.file.path)
  const qname = nestedQname([...namespacePath, name])
  out.push({
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
  const body = node.childForFieldName("body") ?? findChild(node, "statement_block")
  if (body === null) return
  visitModuleLevel(body, ctx, [...namespacePath, name], out)
}

/**
 * `const f = () => ...` / `const g = function() { ... }` — the arrow / function expression
 * on the right-hand side is treated as a top-level Symbol whose name is the variable
 * binding. Any other value (`const x = 1`) becomes a plain `const` Symbol whose signature
 * is null.
 */
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

function makeSourceRange(node: Node, ctx: ExtractionContext): IRSymbol["source"] {
  return {
    file: ctx.file.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: null,
    endColumn: null,
  }
}

/**
 * Read the `/** ... *\/` comment immediately preceding a declaration, if any.
 *
 * Wrapper handling: if the declaration is inside an `export_statement` (`export function
 * f() {}`), the JSDoc lives before the export wrapper, not before the declaration itself.
 * Walk up to the outermost wrapper before scanning siblings.
 */
function readLeadingJsDoc(node: Node): string | null {
  const anchor = outerStatementWrapper(node)
  const parent = anchor.parent
  if (parent === null) return null
  const siblings = parent.children
  const index = siblings.findIndex((s) => s !== null && s.id === anchor.id)
  if (index <= 0) return null
  const collected: string[] = []
  for (let i = index - 1; i >= 0; i--) {
    const sibling = siblings[i]
    if (sibling === null || sibling === undefined) continue
    if (sibling.type === "comment") {
      collected.push(sibling.text)
      continue
    }
    break
  }
  if (collected.length === 0) return null
  return collected.reverse().join("\n")
}

function outerStatementWrapper(node: Node): Node {
  const parent = node.parent
  if (parent !== null && parent.type === "export_statement") return parent
  return node
}
