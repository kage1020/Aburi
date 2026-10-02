---
"@aburi/lang-typescript": patch
---

An `if` is now recorded as a `guard` only when its body can leave the flow the `if` sits in. A `return` inside a callback written in the body (`list.forEach((i) => { if (!i) return })`), a `break` of a `switch` nested there, and a `break` or `continue` of an inner loop used to count, so the enclosing `if` became a guard nobody wrote: giving an arrow in an `if` a block body, `(i) => { return i.id }` for `(i) => i.id`, was reported as a logic change and tripped `--fail-on logic-changed`. Functions written in the body (methods included) are no longer entered, and a `break` or `continue` counts only when its loop, `switch` or label is outside the `if`. Symbols that had such a guard lose it and get a new `logic` value once.
