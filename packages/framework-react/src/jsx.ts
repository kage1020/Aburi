import type { OpaqueAstNode } from "@aburi/types"

/**
 * Minimal shape of a web-tree-sitter Node that this plugin needs. We duck-type instead of
 * importing `web-tree-sitter` directly so `@aburi/framework-react` avoids taking the
 * runtime dependency for the sole purpose of reading node types — the plugin is already
 * pinned to lang-typescript's tree-sitter output through `OpaqueAstNode`.
 */
interface SyntaxNode {
  readonly type: string
  readonly text: string
  readonly namedChildren: readonly (SyntaxNode | null)[]
  readonly children: readonly (SyntaxNode | null)[]
  childForFieldName(name: string): SyntaxNode | null
}

/** Tree-sitter node types the tsx grammar uses for JSX. */
const JSX_NODE_TYPES: ReadonlySet<string> = new Set([
  "jsx_element",
  "jsx_self_closing_element",
  "jsx_fragment",
  "jsx_opening_element",
])

/**
 * True when `body` (or any descendant) contains a JSX element / fragment. Used as the
 * primary component-detection signal: a PascalCase function that returns JSX is a
 * component; one that never emits JSX is not.
 *
 * Accepts `null` so callers can pass `symbol.bodyNode` verbatim without a pre-guard.
 * Returns `false` for a null body, an unwrapped non-tree node (guards a duck-type mismatch
 * from a lang plugin that does not emit tree-sitter shapes), or a body with no JSX.
 */
export function hasJsxReturn(body: OpaqueAstNode | null): boolean {
  const node = asSyntaxNode(body)
  if (node === null) return false
  return findFirstJsxDescendant(node) !== null
}

/**
 * Return the name of the first JSX opening element found under `body`, or `null` if the
 * body contains no JSX. Used by provider detection to check for `X.Provider` shapes — the
 * returned string is the raw source of the opening element's `name` field (e.g. `"div"`,
 * `"MyComponent"`, `"Context.Provider"`, `"React.Fragment"`).
 *
 * Accepts `null` for the same reason as `hasJsxReturn`.
 */
export function findFirstJsxElementName(body: OpaqueAstNode | null): string | null {
  const node = asSyntaxNode(body)
  if (node === null) return null
  const first = findFirstJsxElement(node)
  if (first === null) return null
  return jsxElementName(first)
}

function findFirstJsxDescendant(node: SyntaxNode): SyntaxNode | null {
  if (JSX_NODE_TYPES.has(node.type)) return node
  for (const child of node.children) {
    if (child === null) continue
    const found = findFirstJsxDescendant(child)
    if (found !== null) return found
  }
  return null
}

/**
 * Find the first `jsx_element` / `jsx_self_closing_element` / `jsx_fragment` (opening
 * element itself is skipped — it is a subtree of `jsx_element` and provider detection
 * cares about the wrapping element form).
 */
function findFirstJsxElement(node: SyntaxNode): SyntaxNode | null {
  const t = node.type
  if (t === "jsx_element" || t === "jsx_self_closing_element" || t === "jsx_fragment") {
    return node
  }
  for (const child of node.children) {
    if (child === null) continue
    const found = findFirstJsxElement(child)
    if (found !== null) return found
  }
  return null
}

/**
 * Extract the opening-element name for a jsx_element / jsx_self_closing_element / fragment.
 *
 * `jsx_element` carries its opening element on the `open_tag` field (grammar-dependent) or
 * as the first named child; we probe both. Fragments have no name — return the empty
 * string so downstream `endsWith(".Provider")` checks fall through cleanly.
 */
function jsxElementName(node: SyntaxNode): string {
  if (node.type === "jsx_fragment") return ""
  if (node.type === "jsx_self_closing_element") {
    const name = node.childForFieldName("name")
    return name?.text ?? ""
  }
  // jsx_element — walk to its opening element and read the `name` field.
  const opening = node.childForFieldName("open_tag") ?? findChildOfType(node, "jsx_opening_element")
  if (opening === null) return ""
  const name = opening.childForFieldName("name")
  return name?.text ?? ""
}

function findChildOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
  }
  return null
}

/**
 * True when `text` denotes a member expression whose final segment is `Provider`, e.g.
 * `MyContext.Provider`, `foo.bar.Provider`. Plain identifiers named `Provider` are
 * intentionally excluded — the interesting shape is `<X.Provider>` because that is the
 * unambiguous context-provider signal; a bare `<Provider>` component could be anything.
 */
export function isProviderElementName(name: string): boolean {
  if (name === "") return false
  if (!name.includes(".")) return false
  const last = name.slice(name.lastIndexOf(".") + 1)
  return last === "Provider"
}

/**
 * Narrow `OpaqueAstNode | null` to the minimal `SyntaxNode` shape when the underlying
 * value has the tree-sitter surface (a string `type` and children arrays). Returns `null`
 * for anything else so a lang plugin that hands us a non-tree-sitter node does not blow
 * up mid-walk.
 */
function asSyntaxNode(value: unknown): SyntaxNode | null {
  if (value === null || typeof value !== "object") return null
  const candidate = value as Partial<SyntaxNode>
  if (typeof candidate.type !== "string") return null
  if (!Array.isArray(candidate.children) || !Array.isArray(candidate.namedChildren)) return null
  if (typeof candidate.childForFieldName !== "function") return null
  return candidate as SyntaxNode
}
