---
"@aburi/core": patch
---

`calleeName(call)` returns `{ name, leaf }` for a call whose callee is a name or a member access, and `null` for any other callee. `leaf` is the name called: the callee itself, or the member access's property. `name` is the bare name itself, or `<receiver>.<leaf>`, the receiver being the name the chain starts from, read through `unwrapValue`'s wrappers and through every call, member access and index on the way (`app.get` for `app.route("/x").get(…)` and `(app as Express).get(…)`), and `<computed>` when the chain starts from something that is not a name. `anyCallCalleeMatches` now matches `calleeName(call).leaf` rather than whatever followed the last `.` in the callee's text, so a call whose `.` ends a line or is followed by a comment matches as its one-line spelling does.
