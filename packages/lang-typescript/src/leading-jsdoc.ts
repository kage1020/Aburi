import type { Node } from "web-tree-sitter"
import { AMBIENT_DECLARATION_TYPE } from "./ast-helpers"

export function readLeadingJsDoc(node: Node): string | null {
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
