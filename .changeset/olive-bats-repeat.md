---
"@aburi/lang-typescript": minor
---

A function written in plain sight has its body walked

Two shapes where the extractor was looking straight at a function and did not see it.

**Behind a wrapper.** `const h = (() => { … })`, `… satisfies H`, `… as any`, `…!` — a
parenthesis, a type assertion and a non-null assertion all leave the value exactly what it was,
but the test for "is this binding a function" only accepted a bare arrow or function
expression. The binding came out `kind: "const"` with no body, so everything it did was in no
Symbol. It now reads through those wrappers, in the one predicate the whole plugin shares, so a
module-level binding, a class field and a registration argument cannot answer differently.

A **call** is not a wrapper. `withAuth(() => …)` returns a function by convention and nothing
in the tree says so; reading through it would be a guess rather than an unwrap.

**In argument position.** `app.post("/users", async (req, res) => { … })` already produced a
Symbol for the registration, with no body — so a route whose handler wrote to the database
reported nothing, and every route in a file shared one `fingerprint.logic`, because they all
had zero rules and zero effects. The functions written as direct arguments of the statement's
calls are now the Symbol's bodies, in source order. A chained registration
(`app.route(p).get(h1).post(h2)`) is one statement and one Symbol, so both handlers are walked.

The registration's own `signature` stays `null`: it is the registration, not the handler, and
reading the handler's would publish the framework's callback shape as the route's API.

What moves: a registration Symbol with an inline handler gains that handler's calls, rules and
effects; its `fingerprint.syntax` changes, because the normalized string is now the handler's
body rather than the whole call, and its `fingerprint.logic` changes wherever the handler
contributes a rule or an effect. A registration with no function argument
(`app.listen(3000)`), or one whose handler is passed by name (`app.get("/x", handler)`), is
unchanged.
