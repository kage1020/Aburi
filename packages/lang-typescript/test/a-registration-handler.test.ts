import { describe, expect, it } from "vitest"
import { callsOf, normalizedOf, symbolOf, walkOf } from "./fixtures/ctx"

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
    [
      "both handlers of a chained registration",
      'app.route("/x").get(() => { read() }).post(() => { write() })',
      "ts:src/a.ts#app__post__$x__d0",
      ["read", "write"],
    ],
    [
      "a chain with a wrapper standing in the middle",
      '(app.route("/x").get(() => { read() })).post(() => { write() })',
      "ts:src/a.ts#app__post__$x__d0",
      ["read", "write"],
    ],
    [
      "a call standing behind a member step",
      "app.use(() => { h0() }).router.get(() => { h1() })",
      "ts:src/a.ts#app__get__d0",
      ["h0", "h1"],
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

  it.each([
    [
      "no argument at all",
      "app.listen(3000)",
      "ts:src/a.ts#app__listen__d0",
      ["call-statement:app.listen"],
    ],
    [
      "a handler passed by name",
      'app.get("/x", handler)',
      "ts:src/a.ts#app__get__$x__d0",
      ["call-statement:app.get", "path-literal:/x"],
    ],
    [
      "a generator, which is not a function at any site",
      "app.use(function* (ctx, next) { h1() })",
      "ts:src/a.ts#app__use__d0",
      ["call-statement:app.use"],
    ],
    [
      "a handler whose body the parser only recovered",
      'app.get("/users", async (req, res) =>)',
      "ts:src/a.ts#app__get__$users__d0",
      ["call-statement:app.get", "path-literal:/users"],
    ],
  ])("gives a registration with %s no body", async (_label, source, id, derivedBy) => {
    const symbol = await symbolOf(source, id)

    expect([symbol.bodyNode, symbol.derivedBy]).toEqual([null, derivedBy])
    expect(await callsOf(source, id)).toEqual([])
  })

  it.each([
    ['app.get("/x", () => { a() })', "ts:src/a.ts#app__get__$x__d0", false],
    ["app.listen(3000)", "ts:src/a.ts#app__listen__d0", false],
    ["app.use(() => { a() }, () => { b() })", "ts:src/a.ts#app__use__d0", true],
  ])("writes the merged key on `%s` only for a second handler", async (source, id, merged) => {
    expect("mergedDeclarations" in (await symbolOf(source, id))).toBe(merged)
  })
})

describe("a registration Symbol is still described by the whole registration", () => {
  const ROUTE = (middleware: string): string =>
    `app.get("/users", ${middleware}async (req, res) => { res.json(1) })`
  const ID = "ts:src/a.ts#app__get__$users__d0"

  it("tells a route's middleware apart, which its body cannot", async () => {
    const bare = await normalizedOf(ROUTE(""), ID)
    const authed = await normalizedOf(ROUTE("authenticate, "), ID)
    const limited = await normalizedOf(ROUTE("rateLimit({ max: 5 }), "), ID)

    expect(bare).not.toBe(authed)
    expect(authed).not.toBe(limited)
  })

  it.each([
    ["an inline handler", ROUTE("")],
    ["a named one", 'app.get("/users", handler)'],
    ["one whose body the parser only recovered", 'app.get("/users", async (req, res) =>)'],
  ])("describes a registration with %s from the call", async (_label, source) => {
    expect((await normalizedOf(source, ID)).startsWith("(call_expression")).toBe(true)
  })
})

describe("the receiver of a registration", () => {
  it.each([
    ["an `as`", '(app as Express).get("/x", () => { read() })'],
    ["a non-null assertion", 'app!.get("/x", () => { read() })'],
    ["an `as` further up the chain", '(app as Express).router.get("/x", () => { read() })'],
    ["a non-null assertion further up the chain", 'app!.router.get("/x", () => { read() })'],
    [
      "a wrapper around a call rather than a receiver",
      "(app.route('/x') as R).get(() => { read() })",
    ],
  ])("is named through %s, the way a value is read through one", async (_label, source) => {
    expect(await callsOf(source, "ts:src/a.ts#app__get__$x__d0")).toEqual(["read"])
  })
})
