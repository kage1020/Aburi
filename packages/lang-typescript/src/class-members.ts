import type { Node } from "web-tree-sitter"
import { findChild, hasChildOfType, nameFieldText } from "./ast-helpers"

/**
 * True when extraction gives this class-body member a SymbolCandidate of its own.
 *
 * Two readers need the same answer and it has to be one answer: extraction asks it to decide
 * what to emit, `walkBody` asks it to decide whose body a member's calls and rules belong to,
 * and the moment they disagree a body is recorded twice or not at all.
 *
 * So the *arguments* have to agree too. `classNode` is the class the member is written in,
 * which the walk reads off `body.parent` — a Symbol's `fullNode` is its **leading declaration**
 * and need not be the class, or a class at all: `const C = 1` beside `class C {}` folds into
 * one Symbol whose `fullNode` is the `lexical_declaration` and whose merged body is the class's.
 *
 * Only a **named** class has member Symbols, and a name is the whole test: extraction reaches a
 * class through the statement walk, where the only unnamed form is an anonymous default export —
 * `<default>` is reserved for the class itself and `<default>.m` is not a qualified name the id
 * builder accepts (`ir-schema.md` §3.2). A class *expression* is never visited there at all, and
 * `export default class C {}` is a `class_declaration` rather than an expression, so no named
 * class reaches either reader without member Symbols.
 *
 * A computed member name gets no Symbol and no diagnostic, which is `ir-schema.md` §3.2's own
 * row for it. Every other shape a class body can hold answers false for the plain reason that
 * it is not a `method_definition`.
 *
 * What it does **not** promise is that the member's name is one the id builder will accept: a
 * string-literal or numeric member name (`class C { "ok"() {} }`) passes here and throws there,
 * which costs the file at the per-file boundary.
 */
export function memberHasOwnSymbol(classNode: Node, member: Node): boolean {
  if (member.type !== "method_definition") return false
  if (nameFieldText(classNode) === null) return false
  return findChild(member, "computed_property_name") === null
}

/**
 * True for the member `new C()` runs.
 *
 * Read by extraction for the Symbol's `kind` and by the walk for whether the body stays on the
 * class, which is one decision seen from two sides — the same reason `memberHasOwnSymbol` is
 * one function.
 *
 * `static` is what separates it from a method that happens to be named `constructor`. A static
 * member is not on the construction path, and `class C { static constructor() {} }` is legal
 * JavaScript, which this plugin also parses: reading it as the constructor put its body on the
 * class as part of what instantiating the class runs, and gave it the instance qname, where it
 * collided with the real constructor's.
 */
export function isConstructorMember(member: Node): boolean {
  if (hasChildOfType(member, "static")) return false
  const name = member.childForFieldName("name")
  return name !== null && name.text === "constructor"
}
