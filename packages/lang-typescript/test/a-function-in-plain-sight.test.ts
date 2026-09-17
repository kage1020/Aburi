import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { callsOf, hintOf, symbolOf, symbolsOf, walkOf } from "./fixtures/ctx"

/**
 * Two shapes where the extractor was looking straight at a function and did not see it: one
 * written behind a wrapper the language uses to say nothing about the value, and one written
 * as an argument to a call that registers it.
 *
 * The first is a predicate question — a `parenthesized_expression`, an `as`, a `satisfies` and
 * a `!` all leave the value exactly what it was. The second is a body question: a registration
 * call already has a Symbol, and the handler is what that Symbol runs.
 */

describe("a function behind a wrapper is a function", () => {
  it.each([
    ["parentheses", "export const h = (() => { doThing() })"],
    ["satisfies", "export const h = ((() => { doThing() })) satisfies H"],
    ["as", "export const h = (() => { doThing() }) as any"],
    ["non-null", "export const h = (() => { doThing() })!"],
    ["nested", "export const h = (((() => { doThing() }) as any) satisfies H)"],
  ])("reads through %s", async (_label, source) => {
    const symbol = await symbolOf(source, "ts:src/a.ts#h")

    expect(symbol.kind).toBe("function")
    expect(symbol.derivedBy).toContain("variable-assigned-function")
    expect(await callsOf(source, "ts:src/a.ts#h")).toEqual(["doThing"])
  })

  it("reads the signature from the function the wrappers hold", async () => {
    const symbol = await symbolOf(
      "export const h = ((d: string, n: number) => d) as Handler",
      "ts:src/a.ts#h",
    )

    expect(symbol.signature?.inputs.map((i) => [i.name, i.type])).toEqual([
      ["d", "string"],
      ["n", "number"],
    ])
  })

  it("leaves a wrapped value that is not a function a const", async () => {
    const symbol = await symbolOf("export const h = (1) as any", "ts:src/a.ts#h")

    expect(symbol.kind).toBe("const")
  })

  it("stops at a call, which is not a wrapper", async () => {
    // `withAuth(...)` returns a function by convention and nothing in the tree says so. The
    // unwrap is syntactic, so it ends here rather than guessing.
    const symbol = await symbolOf("export const h = (withAuth(() => { q() }))", "ts:src/a.ts#h")

    expect(symbol.kind).toBe("const")
  })

  it("stops at a call it is the callee of, which is not a wrapper either", async () => {
    // An immediately-invoked function: `h` is what the call returned, not the function. The
    // unwrap reads through what surrounds a value, never through what is done to it.
    const symbol = await symbolOf("export const h = (() => { q() })()", "ts:src/a.ts#h")

    expect(symbol.kind).toBe("const")
    expect(symbol.bodyNode).toBeNull()
  })

  it("gives a class field holding a wrapped function its own Symbol", async () => {
    // The predicate is shared, so the class field answers the same question the same way.
    const source = ["export class C {", "  f = (() => { q() })", "}"].join("\n")

    expect((await symbolsOf(source)).map((s) => s.id)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.f"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.f")).toEqual(["q"])
  })

  it("does not read a class of wrapped-arrow fields as a data model", async () => {
    const source = ["export class C {", "  f = (() => { q() })", "}"].join("\n")

    expect(await hintOf(source, "ts:src/a.ts#C")).toBeNull()
  })
})

describe("a registration call's inline handler is its body", () => {
  it.each([
    [
      "an arrow",
      'app.post("/users", async (req, res) => { create(req.body) })',
      "ts:src/a.ts#app__post__$users__d0",
      ["create"],
    ],
    [
      "a function expression",
      'app.get("/x", function (req, res) { serve() })',
      "ts:src/a.ts#app__get__$x__d0",
      ["serve"],
    ],
    [
      "a handler behind a wrapper",
      'app.get("/x", (async (req) => { serve() }) as Handler)',
      "ts:src/a.ts#app__get__$x__d0",
      ["serve"],
    ],
    // The arrow's `body` is the expression itself, not a `statement_block` — the most common
    // spelling.
    [
      "an expression-bodied handler",
      'app.get("/x", (req, res) => res.json(x))',
      "ts:src/a.ts#app__get__$x__d0",
      ["res.json"],
    ],
    [
      "every inline handler, in source order",
      "app.use(() => { first() }, () => { second() })",
      "ts:src/a.ts#app__use__d0",
      ["first", "second"],
    ],
    // The Symbol stands for the whole statement, and both handlers are written in it. Naming
    // it after the leaf method is the existing convention and is not what this changes.
    [
      "both handlers of a chained registration",
      'app.route("/x").get(() => { read() }).post(() => { write() })',
      "ts:src/a.ts#app__post__d0",
      ["read", "write"],
    ],
    // The chain is walked through the same wrappers a value is read through; stopping at the
    // parenthesis would leave the first handler in no Symbol at all.
    [
      "a chain with a wrapper standing in the middle",
      '(app.route("/x").get(() => { read() })).post(() => { write() })',
      "ts:src/a.ts#app__post__d0",
      ["read", "write"],
    ],
    [
      "an awaited registration",
      "await app.listen(() => { boot() })",
      "ts:src/a.ts#app__listen__d0",
      ["boot"],
    ],
  ])("walks %s", async (_label, source, id, targets) => {
    expect(await callsOf(source, id)).toEqual(targets)
  })

  it("reports the handler's rules as well as its calls", async () => {
    const source = 'app.get("/x", (req, res) => { if (!req.user) throw new E() })'

    expect((await walkOf(source, "ts:src/a.ts#app__get__$x__d0")).rules.map((r) => r.type)).toEqual(
      ["guard", "throw"],
    )
  })

  it("says nothing extra for a registration with no function argument", async () => {
    const source = "app.listen(3000)"
    const symbol = await symbolOf(source, "ts:src/a.ts#app__listen__d0")

    expect(symbol.bodyNode).toBeNull()
    expect(symbol.derivedBy).toEqual(["call-statement:app.listen"])
    expect(await callsOf(source, "ts:src/a.ts#app__listen__d0")).toEqual([])
  })

  it("leaves a handler passed by name where it was", async () => {
    // Nothing is written in the statement to walk. The edge to `handler` is a resolution
    // question, not a body one.
    const source = 'app.get("/x", handler)'
    const symbol = await symbolOf(source, "ts:src/a.ts#app__get__$x__d0")

    expect(symbol.derivedBy).toEqual(["call-statement:app.get", "path-literal:/x"])
    expect(symbol.bodyNode).toBeNull()
    expect(await callsOf(source, "ts:src/a.ts#app__get__$x__d0")).toEqual([])
  })

  it("records why the Symbol has a body, and keeps its signature null", async () => {
    // The Symbol is the registration, not the handler: a route has no parameters of its own,
    // and reading the handler's would report the framework's callback shape as the route's API.
    const source = 'app.get("/x", (req, res) => { serve() })'
    const symbol = await symbolOf(source, "ts:src/a.ts#app__get__$x__d0")

    expect(symbol.derivedBy).toContain("inline-handler")
    expect(symbol.signature).toBeNull()
  })
})

describe("a registration Symbol is still described by the whole registration", () => {
  const ROUTE = (middleware: string): string =>
    `app.get("/users", ${middleware}async (req, res) => { res.json(1) })`

  it("tells a route's middleware apart, which its body cannot", async () => {
    // A body narrows the normalized string to what the registration *runs*. What it *is* — the
    // path, the method, the middleware standing between them and the handler — is the whole
    // call, and a route that gains an auth middleware has to say so somewhere.
    const bare = await symbolOf(ROUTE(""), "ts:src/a.ts#app__get__$users__d0")
    const authed = await symbolOf(ROUTE("authenticate, "), "ts:src/a.ts#app__get__$users__d0")
    const limited = await symbolOf(
      ROUTE("rateLimit({ max: 5 }), "),
      "ts:src/a.ts#app__get__$users__d0",
    )

    expect(normalizeAst(bare)).not.toBe(normalizeAst(authed))
    expect(normalizeAst(authed)).not.toBe(normalizeAst(limited))
  })

  it("describes an inline handler and a named one the same way", async () => {
    // The two spellings had different change-detection power while one narrowed to a body and
    // the other did not.
    const inline = await symbolOf(ROUTE(""), "ts:src/a.ts#app__get__$users__d0")
    const named = await symbolOf('app.get("/users", handler)', "ts:src/a.ts#app__get__$users__d0")

    expect(normalizeAst(inline).startsWith("(call_expression")).toBe(true)
    expect(normalizeAst(named).startsWith("(call_expression")).toBe(true)
    expect(normalizeAst(inline)).not.toBe(normalizeAst(named))
  })
})

describe("what the registration scan refuses", () => {
  it("refuses a handler whose body the parser only recovered", async () => {
    // `async (req, res) =>` with nothing after it still parses as an arrow, and its `body` is a
    // zero-width error node. Adopting it would describe every broken handler in a workspace
    // with the same string, and claim a handler where there is no body to walk.
    const source = 'app.get("/users", async (req, res) =>)'
    const symbol = await symbolOf(source, "ts:src/a.ts#app__get__$users__d0")

    expect(symbol.bodyNode).toBeNull()
    expect(symbol.derivedBy).not.toContain("inline-handler")
    expect(normalizeAst(symbol).startsWith("(call_expression")).toBe(true)
  })

  it("refuses a generator argument, which is not a function at any site", async () => {
    // Koa's middleware spelling. `generator_function` is outside the predicate's set at every
    // reader, so it registers no body here either.
    const source = "app.use(function* (ctx, next) { h1() })"
    const symbol = await symbolOf(source, "ts:src/a.ts#app__use__d0")

    expect(symbol.bodyNode).toBeNull()
    expect(symbol.derivedBy).toEqual(["call-statement:app.use"])
  })

  it("leaves the merged key absent unless a second handler is written", async () => {
    // `plugins.ts` and LP8i: absent, never empty.
    const one = await symbolOf('app.get("/x", () => { a() })', "ts:src/a.ts#app__get__$x__d0")
    const none = await symbolOf("app.listen(3000)", "ts:src/a.ts#app__listen__d0")
    const two = await symbolOf("app.use(() => { a() }, () => { b() })", "ts:src/a.ts#app__use__d0")

    expect("mergedDeclarations" in one).toBe(false)
    expect("mergedDeclarations" in none).toBe(false)
    expect(two.mergedDeclarations).toHaveLength(1)
  })
})

describe("the statement's spine is one Symbol's worth of registrations", () => {
  it("reaches a call standing behind a member step", async () => {
    // `.use`'s call is not the object of `.get`'s callee — a property access stands between
    // them — and stopping there left `h0` in no Symbol at all.
    const source = "app.use(() => { h0() }).router.get(() => { h1() })"

    expect(await callsOf(source, "ts:src/a.ts#app__get__d0")).toEqual(["h0", "h1"])
  })

  // Until the two readers shared the unwrap these produced no Symbol at all: the receiver
  // walk hand-unwrapped parentheses and nothing else, so a route behind a type assertion was
  // not a route.
  it.each([
    ["an `as`", '(app as Express).get("/x", () => { read() })', "ts:src/a.ts#app__get__$x__d0"],
    ["a non-null assertion", 'app!.get("/x", () => { read() })', "ts:src/a.ts#app__get__$x__d0"],
    // and where the wrapper sits further up the chain than the first step
    [
      "an `as` further up the chain",
      '(app as Express).router.get("/x", () => { read() })',
      "ts:src/a.ts#app__get__$x__d0",
    ],
    [
      "a non-null assertion further up the chain",
      'app!.router.get("/x", () => { read() })',
      "ts:src/a.ts#app__get__$x__d0",
    ],
    // …and where it wraps a call rather than a receiver, which is the other arm of the walk
    ["a wrapped call", "(app.route('/x') as R).get(() => { read() })", "ts:src/a.ts#app__get__d0"],
  ])("names the receiver through %s, the way a value is read through one", async (_l, source, id) => {
    expect(await callsOf(source, id)).toEqual(["read"])
  })
})
