import { isQnameSegment } from "@aburi/core"
import type { Node } from "web-tree-sitter"
import {
  functionValueOf,
  hasChildOfType,
  hasErrorChild,
  inAmbientContext,
  nameFieldText,
} from "./ast-helpers"
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
 * Null rather than a throw: `ir-schema.md` answers a computed name with no Symbol and no
 * diagnostic, and handing the name's source text to the id builder instead would cost the
 * file every Symbol it had at the per-file boundary.
 *
 * A **quoted** name that spells an identifier is that identifier — `"ok"() {}` and `ok() {}`
 * declare the same property (TS2393), so both map onto `ok` and fold in `addClassMembers`.
 * The literal is *decoded* rather than unquoted (`a-quoted-member-name.test.ts`), and a name
 * the parser guessed at is refused on both halves: a partial decode answers `whole: false`,
 * and a literal that did not parse at all leaves a bare `property_identifier` beside an ERROR
 * — see `hasErrorChild` for why the member's own children are read rather than `hasError`.
 *
 * A `number` has no segment at all (`1() {}` is `C[1]`, and the grammar's first character
 * class excludes digits). `#` is not a character the grammar admits either, so a `#`-private
 * member is spelled without it — which maps `#v` and a `v` written beside it onto one id, a
 * defect of its own; the strip is here so a field reaches it the same way a method does.
 */
export function memberNameSegment(member: Node): string | null {
  if (hasErrorChild(member)) return null
  const name = member.childForFieldName("name")
  if (name === null) return null
  if (name.type === "property_identifier") return admitSegment(name.text)
  if (name.type === "private_property_identifier") return admitSegment(name.text.replace(/^#/, ""))
  if (name.type !== "string") return null
  const { value, whole } = decodeStringLiteral(name)
  return whole ? admitSegment(value) : null
}

function admitSegment(candidate: string): string | null {
  return isQnameSegment(candidate) ? candidate : null
}

/**
 * The qualified-name segment extraction gives this class-body member, or null when the member
 * has no SymbolCandidate of its own.
 *
 * **One reader, one answer.** Extraction asks this to decide what to emit and `walkBody` asks
 * it to decide whose body a member's calls and rules belong to; the moment they disagree a
 * body is recorded twice or not at all. It answers with the segment rather than a boolean so
 * extraction does not re-derive what admission already computed — and so a builder cannot be
 * handed a name the id builder then refuses. The *arguments* have to agree too: `classNode` is
 * the class the member is written in, which the walk reads off `body.parent` — a Symbol's
 * `fullNode` is its **leading** declaration and need not be the class at all (`const C = 1`
 * beside `class C {}` folds into one Symbol whose `fullNode` is the `lexical_declaration`).
 *
 * Only a **named** class has member Symbols: the only unnamed form the statement walk reaches
 * is an anonymous default export, where `<default>` is reserved for the class itself and
 * `<default>.m` is not a qualified name the id builder accepts (`ir-schema.md`).
 *
 * Four member shapes qualify. A `method_definition` is a member when `memberNameSegment` gives
 * it one. A field holding a function is a member because calling it is what runs the body
 * (`functionValuedField`). The other two are the shapes a member with **no body of its own**
 * is written in, and what separates them from an overload is whether an implementation can be
 * written beside them:
 *
 * - `abstract_method_signature` is a member. The language forbids an implementation beside it,
 *   so nothing else in the class declares `doIt`, and skipping it left an abstract class
 *   reporting only the methods it happened to implement.
 * - `method_signature` is a member **only in an ambient class**. In an ordinary class body it
 *   is an overload declaration and the implementation beside it carries the body and the
 *   parameter types the member is actually called with — so it stays skipped, which is also
 *   how a top-level `function_signature` behaves. An ambient class body has no implementations
 *   to defer to, and reading its members as overloads left `export declare class` with no
 *   methods at all. A class body of signatures and no implementation therefore still declares
 *   no members outside a `declare`, which is what `tsc` calls TS2391 anyway.
 */
export function memberSymbolSegment(classNode: Node, member: Node): string | null {
  if (nameFieldText(classNode) === null) return null
  const segment = memberNameSegment(member)
  if (segment === null) return null
  if (member.type === "method_definition") return segment
  if (member.type === "abstract_method_signature") return segment
  if (member.type === "method_signature") return inAmbientContext(classNode) ? segment : null
  return functionValuedField(member) === null ? null : segment
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
 * The name gate is the one a method gets, which it can be because a refused name is `null`
 * rather than a throw. `public_field_definition` is the only field shape this plugin sees —
 * every extension it claims, `.js` included, is parsed with the TypeScript or TSX grammar.
 */
export function functionValuedField(member: Node): Node | null {
  if (member.type !== "public_field_definition") return null
  const segment = memberNameSegment(member)
  if (segment === null || segment === CONSTRUCTION_SEGMENT) return null
  return functionValueOf(member)
}

/**
 * True for the member `new C()` runs. Read by extraction for the Symbol's `kind` and by the
 * walk for whether the body stays on the class — one decision seen from two sides, as
 * `memberSymbolSegment` is.
 *
 * The **segment** is compared, not the source text, so `"constructor"() {}` is one too. Two
 * spellings that carry the segment are refused because neither is a property name on the
 * construction path: `static` (legal JavaScript, which this plugin also parses) and a
 * `#`-private name (TS18012, and the `#` the segment drops is what makes it a
 * `PrivateIdentifier`). Reading either as the constructor puts its body on the class and
 * gives it the instance qname, where it collides with the real constructor's.
 */
export function isConstructorMember(member: Node): boolean {
  if (hasChildOfType(member, "static")) return false
  if (hasPrivateName(member)) return false
  return memberNameSegment(member) === CONSTRUCTION_SEGMENT
}

/**
 * How a member's name declares its visibility, from the shape it is written in. The node type
 * and not the text, because the segment no longer carries the answer: `#v` is spelled `v`.
 */
export function hasPrivateName(member: Node): boolean {
  return member.childForFieldName("name")?.type === "private_property_identifier"
}
