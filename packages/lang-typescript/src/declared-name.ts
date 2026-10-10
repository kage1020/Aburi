import { CoreError } from "@aburi/core"
import type { ExtractionContext } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { nameFieldText } from "./ast-helpers"
import { isDefaultExport } from "./export-evidence"
import { defaultExportQname, nestedQname } from "./qname"

export function refuseAnonymousId(message: string, value: string): never {
  throw new CoreError(message, { code: "anonymous-symbol-id-attempted", value })
}

export function requireDeclarationName(node: Node, kind: string, file: string): string {
  const name = nameFieldText(node)
  if (name !== null) return name
  return refuseAnonymousId(
    `Missing name field on ${kind} declaration in ${file}:${node.startPosition.row + 1}; the tree-sitter grammar produced an unexpected shape and this plugin refuses to fabricate a placeholder id`,
    `${file}:${kind}`,
  )
}

export function declaredOrDefaultQname(
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
