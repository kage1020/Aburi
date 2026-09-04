import { isQnameSegment } from "@aburi/core"
import type { Node } from "web-tree-sitter"
import { functionValueOf, hasChildOfType, nameFieldText } from "./ast-helpers"
import { decodeStringLiteral } from "./string-escape"

/**
 * The member segment reserved for what `new C()` runs. A field never holds it: `class C {
 * constructor = () => {} }` is a SyntaxError in an engine, the grammar parses it anyway, and
 * admitting it would either put a field on `#C.constructor` or fold it into the real
 * constructor written beside it.
 */
const CONSTRUCTION_SEGMENT = "constructor"

/**
 * The qualified-name segment a class-body member's written name maps to, or null when the
 * member has no name the grammar can record.
 *
 * A written name and a qname segment are two different things, and null is what says so
 * without costing anything: `ir-schema.md` §3.2 answers a computed name with no Symbol and no
 * diagnostic, and every other name the grammar has no segment for gets the same answer. The
 * alternative was to hand the name's source text to the id builder and let it throw, which is
 * caught at the per-file boundary and costs the file every Symbol it had.
 *
 * A **quoted** name that spells an identifier is that identifier. A property key is a string:
 * `"ok"() {}` and `ok() {}` declare the same property — `tsc` calls the pair TS2300 — so
 * mapping both onto `ok` folds two declarations of one member rather than colliding two
 * members, which is what the fold in `addClassMembers` is for. The literal is *decoded*
 * rather than unquoted, so `"okay"` is `okay`; and a literal whose contents did not
 * wholly parse is refused, because joining what parsed answers a name the source does not
 * contain and the syntax error is already reported.
 *
 * A `number` has no segment at all. `1() {}` is addressed as `C[1]`, and the grammar's first
 * character class excludes digits, so there is nothing to map it onto that is not invented.
 *
 * `#` is not a character the grammar admits either, so a `#`-private member is spelled
 * without it — which maps `#v` and a `v` written beside it onto one id. That is its own
 * defect; the strip is here so a field reaches it the same way a method does, rather than a
 * second way.
 */
export function memberNameSegment(member: Node): string | null {
  const name = member.childForFieldName("name")
  if (name === null) return null
  if (name.type === "property_identifier") return admitSegment(name.text)
  if (name.type === "private_property_identifier") return admitSegment(name.text.replace(/^#/, ""))
  if (name.type !== "string") return null
  const { value, whole } = decodeStringLiteral(name)
  if (value === null || !whole) return null
  return admitSegment(value)
}

function admitSegment(candidate: string): string | null {
  return isQnameSegment(candidate) ? candidate : null
}

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
 * Two member shapes qualify, and both need a name with a segment. A `method_definition` is a
 * member when `memberNameSegment` gives it one, which covers `ir-schema.md` §3.2's own row for
 * a computed name — no Symbol and no diagnostic — and every other name the grammar cannot
 * express. A field holding a function is a member because calling it is what runs the body;
 * see `functionValuedField`. Every other shape a class body can hold answers false for the
 * plain reason that it is neither.
 *
 * Whatever this admits, the id builder accepts: the segment was tested against the grammar
 * before the name was believed, rather than after.
 */
export function memberHasOwnSymbol(classNode: Node, member: Node): boolean {
  if (nameFieldText(classNode) === null) return false
  if (member.type === "method_definition") return memberNameSegment(member) !== null
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
 * The name gate is the one a method gets. It used to be stricter — a written identifier and
 * nothing else — because a name the id builder refuses was a lost file, and that is what
 * `memberNameSegment` answering null instead of throwing removes.
 *
 * `public_field_definition` is the only field shape this plugin sees — every extension it
 * claims, `.js` included, is parsed with the TypeScript or TSX grammar.
 */
export function functionValuedField(member: Node): Node | null {
  if (member.type !== "public_field_definition") return null
  const segment = memberNameSegment(member)
  if (segment === null || segment === CONSTRUCTION_SEGMENT) return null
  return functionValueOf(member)
}

/**
 * True for the member `new C()` runs.
 *
 * Read by extraction for the Symbol's `kind` and by the walk for whether the body stays on the
 * class, which is one decision seen from two sides — the same reason `memberHasOwnSymbol` is
 * one function.
 *
 * The **segment** is what is compared, not the name's source text. A class element whose
 * property name is `constructor` is the constructor whatever the spelling, so `"constructor"()
 * {}` is one — read as a method it took the instance qname and collided with the real
 * constructor's.
 *
 * `static` is what separates it from a method that happens to be named `constructor`. A static
 * member is not on the construction path, and `class C { static constructor() {} }` is legal
 * JavaScript, which this plugin also parses: reading it as the constructor put its body on the
 * class as part of what instantiating the class runs, and gave it the instance qname, where it
 * collided with the real constructor's.
 */
export function isConstructorMember(member: Node): boolean {
  if (hasChildOfType(member, "static")) return false
  return memberNameSegment(member) === CONSTRUCTION_SEGMENT
}

/**
 * How a member's name declares its visibility, from the shape it is written in.
 *
 * The node type and not the text, because the segment no longer carries the answer: `#v` is
 * spelled `v`, and a quoted `"#v"` is a public property whose *characters* start with a `#`.
 * A `private_property_identifier` is the one spelling ECMAScript makes private.
 */
export function hasPrivateName(member: Node): boolean {
  return member.childForFieldName("name")?.type === "private_property_identifier"
}
