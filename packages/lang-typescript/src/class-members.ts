import type { Node } from "web-tree-sitter"
import { findChild, nameFieldText } from "./ast-helpers"

/**
 * True when extraction gives this class-body member a SymbolCandidate of its own.
 *
 * Two readers need the same answer, and it has to be one answer. The extractor asks it to
 * decide what to emit; `walkBody` asks it to decide whose body a member's calls and rules
 * belong to. A member with no Symbol has nowhere else for them to be recorded, so the walk
 * keeps them on the class — and the moment the two sides disagree, that is a body recorded
 * twice or not at all.
 *
 * Two kinds of member have no Symbol:
 *
 * - **A computed name is not a name.** `[Symbol.iterator]() {}` and `["go"]() {}` have
 *   brackets where a qualified-name segment goes, and normalising them into one is refused
 *   rather than deferred: any mangling invents a name the source does not contain, two
 *   different computed keys can collapse onto one segment, and nothing reads it back to what
 *   was written. Silently, and deliberately — the position `lang-plugin.md` LP26e takes on a
 *   computed module specifier, for the same reason: it is not a fault in the source.
 * - **A member of an anonymous default class.** `<default>` is reserved for the class itself
 *   (`ir-schema.md` §3.2), and `<default>.m` is not a qualified name the id builder accepts.
 *
 * `method_signature` and `abstract_method_signature` are false for a third reason: an
 * overload declares nothing its implementation does not, and an abstract member has no body.
 * Neither carries anything the walk would attribute anywhere, so the answer costs nothing.
 *
 * The extractor reaches this only for a named class, so it exercises the computed clause
 * alone; the walk asks about both kinds.
 */
export function memberHasOwnSymbol(classNode: Node, member: Node): boolean {
  if (member.type !== "method_definition") return false
  if (nameFieldText(classNode) === null) return false
  return findChild(member, "computed_property_name") === null
}
