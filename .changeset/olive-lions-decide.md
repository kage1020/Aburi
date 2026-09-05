---
"@aburi/lang-typescript": minor
"@aburi/core": minor
---

Read a quoted class member name as the name it spells, instead of losing the file

`class C { "ok"() {} }` and `class C { 1() {} }` are legal TypeScript — the member is addressed
as `C["ok"]` / `C[1]` — and both cost the file every Symbol it had. The plugin handed the name
node's *source text* to the Symbol-id builder, which refuses anything that is not an identifier;
the throw was caught at the per-file boundary, and the file was named in `stats.skippedFiles`
with `reason: "extraction-failed"`. Widening the qualified-name grammar to ECMAScript's
IdentifierName closed this for a Japanese or accented declaration; a quoted or numeric property
name is a `PropertyName` and was outside that widening by construction.

A written name and a qualified-name segment are two different things now. One function answers
what segment a member's name maps to, or `null` when the grammar has none for it — which is the
answer `ir-schema.md` §3.2 already gives a computed name: **no Symbol, no diagnostic**, and the
body stays on the class, where its calls and rules are still reported.

**A quoted name that decodes to an identifier is that identifier.** A property key is a string,
so `"ok"() {}` and `ok() {}` declare the same property — `tsc` calls the pair TS2393, a
duplicate *implementation* — and they fold onto one Symbol the way a field and a method of
the same name already do. The literal is decoded rather than unquoted, so an escaped spelling
names the member it spells.

**A name the parser guessed at is refused**, and it arrives in two shapes. A literal that parsed
in part keeps its node and is read as incomplete. One that did not parse at all leaves no
literal behind: recovery re-emits the surviving characters as a plain name, so `"\uZZZZ"() {}`
used to record a member called `ZZZZ` — a name the source does not spell. Both now have no
Symbol, which makes the second the one case where this removes a Symbol the previous release
produced. What says the name is a guess is an ERROR among the member's own children, so a
member whose *body* fails to parse keeps its Symbol as before.

Two things follow from having one answer rather than two:

- **`"constructor"() {}` is the constructor.** A class element whose property name is
  `constructor` is the constructor whatever the spelling. Read as a method it took the instance
  qualified name, where it collided with a real constructor's. Two spellings that carry the
  segment stay off the construction path, because neither is a property name: a `static` member,
  and a `#`-private one, whose `#` is exactly what the segment drops.
- **A field holding a function is gated the same way a method is.** The field gate refused every
  name not written as an identifier, because a name the id builder refuses was a lost file. That
  reason is gone, so `"ok" = () => {}` is now the member `ok` — a Symbol where there was none.

One diagnostic is corrected on the way past. A module specifier written as a line continuation
followed by an escape the grammar refuses — `import x from "\<newline>\uZZZZ"` — was reported as
naming no module, on top of the syntax errors that already said why the name could not be read.
The continuation contributes no character, so the read came back empty and was indistinguishable
from an empty literal; reading whether the literal was *wholly* read tells them apart.

`@aburi/core` exports `isQnameSegment`, the single-segment predicate a producer needs to ask
*before* it builds. `isQualifiedName` is the wrong one for that question and fails quietly: it
answers about a finished name, so it admits `.` and `::`, and a caller vetting one member name
with it would accept `"a.b"` and mint the nested qualified name `C.a.b` out of a single member.
