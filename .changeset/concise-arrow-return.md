---
"@aburi/lang-typescript": patch
---

An arrow with an expression body now gets the `return` rule its block spelling does: `const canEdit = (u) => u.role === "admin"` reports `return: u.role === "admin"` as `function canEdit(u) { return u.role === "admin" }` always has. The body was walked as a bare expression, so editing it moved no rule and no `logic` fingerprint, `aburi diff` filed the edit under syntax-only changes, and `--fail-on logic-changed` did not fire. The same triviality rules apply as for `return`: a lone call or `new` records the call and adds no rule, and a name, literal or member chain adds nothing. The one pair of parentheses an object-literal body needs is not part of `expr`. Calls are collected exactly as before. Variable-assigned arrows, class fields holding an arrow, registered handlers and `export default` arrows are all covered.

This moves the `logic` fingerprint of every concise arrow whose expression is non-trivial, so an IR scanned before this release compared with one scanned after reports those Symbols as logic changes. On this repository, scanning one tree with both versions moves 29 Symbols, all of them concise arrows, and leaves every Symbol's calls unchanged.
