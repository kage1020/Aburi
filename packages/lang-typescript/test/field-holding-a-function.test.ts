import { describe, expect, it } from "vitest"
import { callsOf, classOf, hintOf, idsOf, normalizedOf, symbolOf, symbolsOf } from "./fixtures/ctx"

describe("a field holding a function is a member Symbol", () => {
  it("declares one for an arrow", async () => {
    const symbol = await symbolOf(
      classOf("  create = async (d: unknown) => { inner(d) }"),
      "ts:src/a.ts#C.create",
    )

    expect(symbol.kind).toBe("method")
    expect(symbol.derivedBy).toEqual(["class-method", "field-assigned-function"])
  })

  it("declares one for a function expression", async () => {
    const symbol = await symbolOf(
      classOf("  fn = function (a: number) { other(a) }"),
      "ts:src/a.ts#C.fn",
    )

    expect(symbol.kind).toBe("method")
    expect(symbol.derivedBy).toContain("field-assigned-function")
  })

  it.each([
    ["a function", "  static sf = () => { st() }", "field-assigned-function"],
    [
      "a function handed to a call",
      "  static sf = withAuth(() => { st() })",
      "call-argument-function",
    ],
  ])("gives a static field holding %s the static member qname", async (_label, field, spelling) => {
    const source = classOf(field)

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C::sf"])
    expect((await symbolOf(source, "ts:src/a.ts#C::sf")).derivedBy).toEqual([
      "static-method",
      spelling,
    ])
  })

  it("reads a hash-private field as private", async () => {
    const symbol = await symbolOf(classOf("  #priv = () => { pv() }"), "ts:src/a.ts#C.#priv")

    expect(symbol.visibility).toBe("private")
  })

  it("reads an accessibility modifier", async () => {
    const source = classOf(
      "  pub = () => { a() }",
      "  private priv = () => { b() }",
      "  protected prot = () => { c() }",
    )

    expect((await symbolOf(source, "ts:src/a.ts#C.pub")).visibility).toBe("public")
    expect((await symbolOf(source, "ts:src/a.ts#C.priv")).visibility).toBe("private")
    expect((await symbolOf(source, "ts:src/a.ts#C.prot")).visibility).toBe("protected")
  })

  it("takes the signature from the function, not from the field's type annotation", async () => {
    const symbol = await symbolOf(
      classOf("  create: Handler = (d: string, n: number) => d"),
      "ts:src/a.ts#C.create",
    )

    expect(symbol.signature?.inputs.map((i) => [i.name, i.type])).toEqual([
      ["d", "string"],
      ["n", "number"],
    ])
  })

  it("reads the JSDoc written above the field", async () => {
    const source = classOf("  /** @throws {ValidationError} on a bad payload */", "  f = () => {}")
    const symbol = await symbolOf(source, "ts:src/a.ts#C.f")

    expect(symbol.signature?.throws).toEqual(["ValidationError"])
  })

  it("marks an auto-accessor field the way it marks a getter", async () => {
    const symbol = await symbolOf(classOf("  accessor af = () => { q() }"), "ts:src/a.ts#C.af")

    expect(symbol.derivedBy).toEqual([
      "class-method",
      "field-assigned-function",
      "accessor-declaration",
    ])
  })

  it.each([
    "src/a.ts",
    "src/a.tsx",
    "src/a.js",
    "src/a.jsx",
    "src/a.mts",
  ])("declares one in %s", async (path) => {
    const ids = (await symbolsOf(classOf("  f = () => { q() }"), path)).map((s) => s.id)

    expect(ids).toEqual([`ts:${path}#C`, `ts:${path}#C.f`])
  })

  it("reports the field's own source range, not the function's", async () => {
    const source = [
      "export class C {",
      "  @Inject()",
      "  create = () => {",
      "    inner()",
      "  }",
      "}",
    ].join("\n")
    const symbol = await symbolOf(source, "ts:src/a.ts#C.create")

    expect([symbol.source.startLine, symbol.source.endLine]).toEqual([2, 5])
  })

  it("carries the field's decorators", async () => {
    const symbol = await symbolOf(classOf("  @Inject() create = () => {}"), "ts:src/a.ts#C.create")

    expect(symbol.decorators.map((d) => d.name)).toEqual(["Inject"])
  })

  it("walks an expression-bodied arrow", async () => {
    const source = classOf("  create = (d: unknown) => run(d)")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.create")).toEqual(["run"])
  })
})

describe("a field that is not a function stays a field", () => {
  it("leaves an initialiser that runs at construction on the class", async () => {
    const source = classOf("  plain = makeA()")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["makeA"])
  })

  it("leaves a field with no initialiser alone", async () => {
    const source = classOf("  noInit: () => void", "  declare later: () => void")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
  })

  it("leaves a computed name on the class", async () => {
    const source = classOf("  [key] = () => { comp() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["comp"])
  })

  it("refuses a field that spells the construction path", async () => {
    const source = classOf("  constructor() { real() }", "  constructor = () => { c1() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.constructor"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["real", "c1"])
    expect(await callsOf(source, "ts:src/a.ts#C.constructor")).toEqual(["real"])
  })

  it("admits a `#constructor` field, whose segment is not the construction one", async () => {
    const source = classOf("  constructor() { real() }", "  #constructor = () => { c2() }")

    expect(await idsOf(source)).toEqual([
      "ts:src/a.ts#C",
      "ts:src/a.ts#C.#constructor",
      "ts:src/a.ts#C.constructor",
    ])
    expect(await callsOf(source, "ts:src/a.ts#C.#constructor")).toEqual(["c2"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["real"])
    expect(await callsOf(source, "ts:src/a.ts#C.constructor")).toEqual(["real"])
  })
})

describe("a field holding a function handed to a call is a member Symbol", () => {
  const AUTHED = classOf("  handle = withAuth(async (d: unknown) => { inner(d) })")

  it("declares one, with no signature, since the call decides what the member is", async () => {
    const symbol = await symbolOf(AUTHED, "ts:src/a.ts#C.handle")

    expect([symbol.kind, symbol.signature]).toEqual(["method", null])
    expect(symbol.derivedBy).toEqual(["class-method", "call-argument-function"])
  })

  it.each([
    [
      "the function on the member and the call that wraps it on the class",
      "  handle = withAuth(async (d: unknown) => { inner(d) })",
      "handle",
      ["inner"],
      ["withAuth"],
    ],
    [
      "every function handed to a call on the value's chain",
      "  q = t.procedure.input((v) => { parse(v) }).query(() => { load() })",
      "q",
      ["parse", "load"],
      ["t.procedure.input.query", "t.procedure.input"],
    ],
    [
      "a function's parameter defaults with its body",
      "  handle = withAuth((x = fallback()) => { use(x) })",
      "handle",
      ["fallback", "use"],
      ["withAuth"],
    ],
    [
      "each function's parameter defaults with its own body",
      "  piped = pipe(() => { a() }, (x = dflt()) => { b(x) })",
      "piped",
      ["a", "dflt", "b"],
      ["pipe"],
    ],
    [
      "a call behind a wrapper",
      "  handle = (withAuth(() => { inner() })) as Handler",
      "handle",
      ["inner"],
      ["withAuth"],
    ],
    [
      "the function and leaves the call's other arguments on the class",
      "  debounced = debounce(() => { a() }, delay())",
      "debounced",
      ["a"],
      ["debounce", "delay"],
    ],
    [
      "a callback a call runs at once on the member, a known cost",
      "  doubled = xs.map((x) => x * 2)",
      "doubled",
      [],
      ["xs.map"],
    ],
    [
      "a callback a call registers on the member, a known cost",
      "  timer = setInterval(() => { tick() }, 1000)",
      "timer",
      ["tick"],
      ["setInterval"],
    ],
  ])("walks %s", async (_label, field, member, onMember, onClass) => {
    const source = classOf(field)

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", `ts:src/a.ts#C.${member}`])
    expect(await callsOf(source, `ts:src/a.ts#C.${member}`)).toEqual(onMember)
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(onClass)
  })

  it.each([
    [
      "an empty handler before one with code",
      "  ready = p.then(() => {}).catch((e) => report(e))",
      null,
      ["report"],
    ],
    [
      "an empty handler after one with code",
      "  ready = p.then((r) => use(r), () => {})",
      null,
      ["use"],
    ],
    [
      "only empty handlers",
      "  ready = p.then(() => {}, () => {})",
      { reason: "empty body", category: "B" },
      [],
    ],
  ])("hints a member of %s by every body it has", async (_label, field, hint, onMember) => {
    const source = classOf(field)

    expect(await hintOf(source, "ts:src/a.ts#C.ready")).toEqual(hint)
    expect(await callsOf(source, "ts:src/a.ts#C.ready")).toEqual(onMember)
  })

  it.each([
    [
      "the call that wraps the function",
      "  handle = withAuth(() => { inner() })",
      "  handle = withRole(() => { inner() })",
    ],
    [
      "the field's type annotation",
      "  handle: Auth = withAuth(() => { inner() })",
      "  handle: Role = withAuth(() => { inner() })",
    ],
  ])("describes the whole field, so changing %s is an edit", async (_label, before, after) => {
    const describe = (field: string) => normalizedOf(classOf(field), "ts:src/a.ts#C.handle")

    expect(await describe(before)).not.toBe(await describe(after))
  })

  it.each([
    [
      "a function inside an argument",
      "  handle = withAuth(withLogging(() => { a() }))",
      ["withAuth", "withLogging", "a"],
    ],
    [
      "a function handed to `new`",
      "  ready = new Promise((resolve) => { a(resolve) })",
      ["Promise", "a"],
    ],
    ["a call handed no function", "  client = makeClient(options)", ["makeClient"]],
    ["a function the value invokes in place", "  seed = (() => { a() })()", ["<computed>", "a"]],
  ])("leaves %s on the class", async (_label, field, onClass) => {
    const source = classOf(field)

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(onClass)
  })
})

describe("a field and a method of one name are one member", () => {
  it("folds a field and a method of the same name onto one member", async () => {
    const source = classOf("  m() { a() }", "  m = () => { b() }")
    const symbol = await symbolOf(source, "ts:src/a.ts#C.m")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.m"])
    expect(symbol.derivedBy).toContain("declaration-merged")
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.m")).toEqual(["a", "b"])
  })

  it("lets whichever declaration is written first lead the fold", async () => {
    const source = classOf("  m = () => { b() }", "  m() { a() }")
    const symbol = await symbolOf(source, "ts:src/a.ts#C.m")

    expect(symbol.derivedBy).toContain("field-assigned-function")
    expect(await callsOf(source, "ts:src/a.ts#C.m")).toEqual(["b", "a"])
  })
})

describe("a class of function-valued fields is not a data model", () => {
  it("does not read as a pure DTO", async () => {
    const source = classOf("  create = () => { inner() }", "  read = () => { other() }")

    expect(await hintOf(source, "ts:src/a.ts#C")).toBeNull()
  })

  it("does not read a class of computed-name arrow fields as one either", async () => {
    const source = classOf("  [key] = () => { x() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await hintOf(source, "ts:src/a.ts#C")).toBeNull()
  })

  it("reads a class of fields holding functions it does not recognise as one", async () => {
    const nested = classOf("  handle = withAuth(withLogging(() => { inner() }))")

    expect(await hintOf(nested, "ts:src/a.ts#C")).toEqual({ reason: "pure DTO", category: "B" })
    expect(await callsOf(nested, "ts:src/a.ts#C")).toEqual(["withAuth", "withLogging", "inner"])
  })

  it.each([
    [
      "a field holding a function handed to a call",
      "  handle = withAuth(() => { inner() })",
      ["withAuth"],
    ],
    [
      "the same field under a computed name",
      "  [key] = withAuth(() => { inner() })",
      ["withAuth", "inner"],
    ],
  ])("does not read a class of %s as one", async (_label, field, onClass) => {
    const source = classOf(field)

    expect(await hintOf(source, "ts:src/a.ts#C")).toBeNull()
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(onClass)
  })

  it("hints an empty function-valued field as an empty body", async () => {
    const source = classOf("  create = () => {}")

    expect(await hintOf(source, "ts:src/a.ts#C.create")).toEqual({
      reason: "empty body",
      category: "B",
    })
  })
})

describe("module-level variables", () => {
  it("extracts an arrow, a function expression and a generator as functions, and any other initialiser as a const", async () => {
    const source = [
      "export const f = () => { a() }",
      "export const g = function () { b() }",
      "export const h = 1",
      "export const i = function* () { c() }",
    ].join("\n")
    const symbols = await symbolsOf(source)

    expect(symbols.map((s) => [s.id, s.kind, s.derivedBy])).toEqual([
      ["ts:src/a.ts#f", "function", ["variable-assigned-function", "export-keyword"]],
      ["ts:src/a.ts#g", "function", ["variable-assigned-function", "export-keyword"]],
      ["ts:src/a.ts#h", "const", ["export-keyword"]],
      ["ts:src/a.ts#i", "function", ["variable-assigned-function", "export-keyword"]],
    ])
  })
})
