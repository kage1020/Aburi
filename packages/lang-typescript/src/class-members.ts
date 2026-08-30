import type { Node } from "web-tree-sitter"
import { findChild, functionValueOf, hasChildOfType, nameFieldText } from "./ast-helpers"

/**
 * The member segment reserved for what `new C()` runs. A field never holds it: `class C {
 * constructor = () => {} }` is a SyntaxError in an engine, the grammar parses it anyway, and
 * admitting it would either put a field on `#C.constructor` or fold it into the real
 * constructor written beside it.
 */
const CONSTRUCTION_SEGMENT = "constructor"

/**
 * The node types a member name is written as when it *is* a name. A computed name is a
 * `computed_property_name`, and a quoted or numeric one is a `string` / `number` — neither is
 * a qualified-name segment (`ir-schema.md` §3.2), and the id builder's refusal is a throw
 * that costs the whole file.
 */
const WRITTEN_MEMBER_NAME_TYPES: ReadonlySet<string> = new Set([
  "property_identifier",
  "private_property_identifier",
])

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
 * Two member shapes qualify. A `method_definition` is a member unless its name is computed,
 * which is `ir-schema.md` §3.2's own row for it — no Symbol and no diagnostic. A field holding
 * a function is a member because calling it is what runs the body; see `functionValuedField`.
 * Every other shape a class body can hold answers false for the plain reason that it is
 * neither.
 *
 * What it does **not** promise, for a `method_definition`, is that the member's name is one the
 * id builder will accept: a string-literal or numeric member name (`class C { "ok"() {} }`)
 * passes here and throws there, which costs the file at the per-file boundary.
 */
export function memberHasOwnSymbol(classNode: Node, member: Node): boolean {
  if (nameFieldText(classNode) === null) return false
  if (member.type === "method_definition") {
    return findChild(member, "computed_property_name") === null
  }
  return functionValuedField(member) !== null
}

/**
 * The function a class field holds, when the field is a member of its own — otherwise null.
 *
 * `create = async (d) => { … }` declares a member the same way `create(d) { … }` does. What
 * separates the two from `seed = makeSeed()` is *when the body runs*: constructing the class
 * creates the closure and does not enter it, so the body is what calling the member runs and
 * belongs to the member's Symbol, while `makeSeed()` runs on construction and belongs to the
 * class (`lang-plugin.md` LP20a).
 *
 * The name gate is stricter than the one `method_definition` gets, and deliberately: a field
 * with a name the id builder refuses is a file this plugin extracts today, and admitting it
 * would turn that into a lost file rather than into a member.
 *
 * `public_field_definition` is the only field shape this plugin sees — every extension it
 * claims, `.js` included, is parsed with the TypeScript or TSX grammar.
 */
export function functionValuedField(member: Node): Node | null {
  if (member.type !== "public_field_definition") return null
  const name = member.childForFieldName("name")
  if (name === null || !WRITTEN_MEMBER_NAME_TYPES.has(name.type)) return null
  if (memberSegment(name.text) === CONSTRUCTION_SEGMENT) return null
  return functionValueOf(member)
}

/**
 * The qualified-name segment a written member name maps to.
 *
 * `#` is not a character `ir-schema.md` §3.2's grammar admits, so a `#`-private member is
 * spelled without it — which maps `#v` and a `v` written beside it onto one id. The strip is
 * shared so a field reaches that one defect the same way a method does, rather than a second
 * way.
 */
export function memberSegment(writtenName: string): string {
  return writtenName.replace(/^#/, "")
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
 *
 * The member shape is not asked about, because it cannot vary: the only two shapes that reach
 * here are a `method_definition` and a field `functionValuedField` admitted, and that refuses
 * the name outright.
 */
export function isConstructorMember(member: Node): boolean {
  if (hasChildOfType(member, "static")) return false
  const name = member.childForFieldName("name")
  return name !== null && name.text === CONSTRUCTION_SEGMENT
}
