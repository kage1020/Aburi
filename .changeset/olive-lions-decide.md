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
so `"ok"() {}` and `ok() {}` declare the same property — `tsc` calls the pair TS2300 — and they
fold onto one Symbol the way a field and a method of the same name already do. The literal is
decoded rather than unquoted, so an escaped spelling names the member it spells; a literal whose
contents did not wholly parse is refused instead, because joining what parsed would mint an id
for a name the source does not contain.

Two things follow from having one answer rather than two:

- **`"constructor"() {}` is the constructor.** A class element whose property name is
  `constructor` is the constructor whatever the spelling. Read as a method it took the instance
  qualified name, where it collided with a real constructor's.
- **A field holding a function is gated the same way a method is.** The field gate refused every
  name not written as an identifier, because a name the id builder refuses was a lost file. That
  reason is gone, so `"ok" = () => {}` is now the member `ok` — a Symbol where there was none.

`@aburi/core` exports `isQnameSegment`, the single-segment predicate a producer needs to ask
*before* it builds. `isQualifiedName` is the wrong one for that question and fails quietly: it
answers about a finished name, so it admits `.` and `::`, and a caller vetting one member name
with it would accept `"a.b"` and mint the nested qualified name `C.a.b` out of a single member.
