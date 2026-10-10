import { describe, expect, it } from "vitest"
import { BACKSLASH, idsOf, symbolOf, symbolsOf } from "./fixtures/ctx"

/** The ids of the registration Symbols a module of these statements declares, sorted. */
async function callIds(lines: readonly string[]): Promise<string[]> {
  return (await symbolsOf(`${lines.join("\n")}\n`))
    .filter((s) => s.kind === "call")
    .map((s) => s.id)
    .sort()
}

const pathTags = (derivedBy: readonly string[]) =>
  derivedBy.filter((tag) => tag.startsWith("path-literal:"))

describe("a module-level registration call is a Symbol", () => {
  it("of kind call, whose body is its inline handler and whose rationale is the call", async () => {
    const symbol = await symbolOf(
      "app.get('/users', (req, res) => { res.send('ok') })\n",
      "ts:src/a.ts#app__get__$users__d0",
    )

    expect(symbol).toMatchObject({ kind: "call", signature: null, decorators: [] })
    expect(symbol.bodyNode?.type).toBe("statement_block")
    expect(symbol.derivedBy).toEqual([
      "call-statement:app.get",
      "path-literal:/users",
      "inline-handler",
    ])
  })

  it("records a chained receiver, rooted on the name the chain starts from", async () => {
    const symbol = await symbolOf(
      "app.route('/thing').get(handler)\n",
      "ts:src/a.ts#app__get__$thing__d0",
    )

    expect(symbol.derivedBy).toEqual([
      "call-statement:app.get",
      "chained-call",
      "path-literal:/thing",
    ])
  })

  it("is read from an ordinary expression statement, which wraps no declaration", async () => {
    expect(await idsOf("import { app } from './app'\napp.get('/users', () => 1)\n")).toEqual([
      "ts:src/a.ts#app__get__$users__d0",
    ])
  })

  it.each([
    ["a method no framework registers through", "Sentry.captureException(new Error('boom'))"],
    ["a bare identifier's call", "setup()"],
    ["a registration inside a namespace", "namespace N { app.get('/x', h) }"],
  ])("is not made of %s", async (_label, source) => {
    expect((await symbolsOf(`${source}\nconst y = 2\n`)).filter((s) => s.kind === "call")).toEqual(
      [],
    )
  })
})

describe("a registration is named by its path", () => {
  it.each([
    ["a path literal", "app.get('/users', h)", "$users", "/users"],
    ["a route parameter", "app.get('/users/:id', h)", "$users$Zid", "/users/:id"],
    ["a path written in backticks", "app.get(`/users`, h)", "$users", "/users"],
    ["a path behind a comment", 'app.get(/* why */ "/users", h)', "$users", "/users"],
    ["a path in parentheses", 'app.get(("/users"), h)', "$users", "/users"],
    ["a path behind an assertion", 'app.get("/users" as string, h)', "$users", "/users"],
    ["a path behind a satisfies", 'app.get("/users" satisfies string, h)', "$users", "/users"],
    ["a hex escape", `app.get("/hex${BACKSLASH}x41fter", h)`, "$hexAfter", "/hexAfter"],
    ["a tab", `app.get("/tab${BACKSLASH}tinside", h)`, "$tab_inside", "/tab\tinside"],
    [
      "an escaped backslash",
      `app.get("/back${BACKSLASH}${BACKSLASH}slash", h)`,
      "$back_slash",
      "/back\\slash",
    ],
    ["a unicode escape", `app.get("/us${BACKSLASH}u0065rs", h)`, "$users", "/users"],
    ["the earliest of two paths in a chain", "app.route('/a').get('/b', h)", "$a", "/a"],
    ["a path behind a member step", "app.use(h0).router.get('/x', h1)", "$x", "/x"],
  ])("reads %s", async (_label, source, slug, path) => {
    const symbol = await symbolOf(`${source}\n`, `ts:src/a.ts#app__get__${slug}__d0`)

    expect(pathTags(symbol.derivedBy)).toEqual([`path-literal:${path}`])
  })
})

describe("a registration with no path is named by the names its arguments carry", () => {
  it.each([
    ["an identifier", "app.use(logger)", "app__use__logger"],
    ["a call, by its callee", "app.use(express.json())", "app__use__express_json"],
    [
      "a call with arguments, by its callee",
      'app.use(express.static("public"))',
      "app__use__express_static",
    ],
    [
      "several arguments, joined",
      "app.use(rateLimit({ max: 5 }), audit.log)",
      "app__use__rateLimit$audit_log",
    ],
    ["a constructor", "app.use(new Logger())", "app__use__Logger"],
    ["a spread", "app.use(...mws)", "app__use__mws"],
    ["a three-level member", "app.use(a.b.c)", "app__use__a_b_c"],
    ["a call inside a dotted path", "app.use(a.b().c)", "app__use__a_b_c"],
    ["a wrapped argument", "app.use((authMw as Handler))", "app__use__authMw"],
    ["only the leaf call's arguments", "app.use(a).get(b)", "app__get__b"],
    [
      "a backtick path that substitutes, which is no path",
      `app.get(\`/users/\${id}\`, h)`,
      "app__get__h",
    ],
    ["an empty path, which says nothing", 'app.get("", h)', "app__get__h"],
    [
      "a call that starts the chain, whose argument is no mount path",
      'require("express")().get(h)',
      "require__get__h",
    ],
  ])("reads %s", async (_label, source, stem) => {
    const symbol = await symbolOf(`${source}\n`, `ts:src/a.ts#${stem}__d0`)
    const names = stem.slice(stem.lastIndexOf("__") + 2)

    expect(symbol.derivedBy).toContain(`argument-names:${names}`)
    expect(pathTags(symbol.derivedBy)).toEqual([])
  })

  it("tells a name apart from a path that slugs the same only by its tag", async () => {
    const symbols = await symbolsOf('app.use($api)\napp.use("/api", x)\n')

    expect(symbols.map((s) => [s.id, s.derivedBy])).toEqual([
      ["ts:src/a.ts#app__use__$api__d0", ["call-statement:app.use", "argument-names:$api"]],
      ["ts:src/a.ts#app__use__$api__d1", ["call-statement:app.use", "path-literal:/api"]],
    ])
  })
})

describe("registrations that agree on a name", () => {
  it.each([
    [
      "three that agree on receiver, method and path",
      ["app.get('/x', a)", "app.get('/x', b)", "app.get('/x', c)"],
      ["app__get__$x__d0", "app__get__$x__d1", "app__get__$x__d2"],
    ],
    [
      "a path that spells an ordinal",
      ["app.get('/x', a)", "app.get('/x', b)", "app.get('/x__d1', c)"],
      ["app__get__$x__d0", "app__get__$x__d1", "app__get__$x__d1__d0"],
    ],
    [
      "two paths neither of which could be read",
      [`app.get("${BACKSLASH}u12b/a", h)`, `app.get("${BACKSLASH}u12b/b", h)`],
      ["app__get___u12b$a__d0", "app__get___u12b$b__d0"],
    ],
    [
      "argument names that join to the same stem",
      [
        'app.use(express.static("a"))',
        'app.use(express.static("b"))',
        "app.use(a, b)",
        "app.use(a$b)",
      ],
      [
        "app__use__a$b__d0",
        "app__use__a$b__d1",
        "app__use__express_static__d0",
        "app__use__express_static__d1",
      ],
    ],
    [
      "names outside ASCII, kept as the qualified-name grammar keeps them",
      ["app.use(認証)", "app.use(圧縮)", 'app.get("/ユーザー", h)', "アプリ.use(café)"],
      [
        "app__get__$ユーザー__d0",
        "app__use__圧縮__d0",
        "app__use__認証__d0",
        "アプリ__use__café__d0",
      ],
    ],
  ])("are told apart by order, for %s", async (_label, lines, names) => {
    expect(await callIds(lines)).toEqual(names.map((name) => `ts:src/a.ts#${name}`))
  })

  it("are named in Unicode NFC, whichever spelling the file was saved in", async () => {
    const symbols = await symbolsOf(
      ["app.use(cafe\u0301)", "app.use(caf\u00e9)", 'app.get("/a:\u0301", h)'].join("\n"),
    )

    expect(symbols.map((s) => s.name)).toEqual([
      "app__get__$a\u0179__d0",
      "app__use__caf\u00e9__d0",
      "app__use__caf\u00e9__d1",
    ])
  })
})

describe("a registration's id does not move when other lines are written around it", () => {
  const inline =
    "app.use((req, res, next) => {\n  if (!req.headers.authorization) return\n  next()\n})"

  it.each([
    [
      "a route mounted through app.route ahead of two others",
      ["app.route('/a').get(h)", "app.route('/b').get(h)"],
      "app.route('/new').get(h)",
      ["app__get__$new__d0"],
    ],
    [
      "a registration with no path ahead of others",
      ["app.use(cors())", "app.use(helmet())", "app.use(authMw)", inline],
      "app.use(compression())",
      ["app__use__compression__d0"],
    ],
    ["an import above it", ["app.get('/users', h)"], 'import { z } from "zod"', []],
    ["a comment block above it", ["app.get('/users', h)"], "// hoisted note\n// another line", []],
  ])("keeps every id when %s is written", async (_label, lines, inserted, added) => {
    const before = await callIds(lines)

    expect(await callIds([inserted, ...lines])).toEqual(
      [...before, ...added.map((name) => `ts:src/a.ts#${name}`)].sort(),
    )
  })
})
