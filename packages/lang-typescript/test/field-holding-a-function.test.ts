import { describe, expect, it } from "vitest"
import { callsOf, classOf, hintOf, idsOf, symbolOf, symbolsOf } from "./fixtures/ctx"

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

  it("gives a static field the static member qname", async () => {
    const symbol = await symbolOf(classOf("  static sf = () => { st() }"), "ts:src/a.ts#C::sf")

    expect(symbol.derivedBy).toContain("static-method")
    expect(symbol.derivedBy).not.toContain("class-method")
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

  it("leaves a generator field on the class", async () => {
    const source = classOf("  gen = function* () { yield g() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["g"])
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
    const generator = classOf("  gen = function* () { yield q() }")
    const wrapped = classOf("  handle = withAuth(() => { inner() })")

    expect(await hintOf(generator, "ts:src/a.ts#C")).toEqual({
      reason: "pure DTO",
      category: "B",
    })
    expect(await callsOf(generator, "ts:src/a.ts#C")).toEqual(["q"])
    expect(await hintOf(wrapped, "ts:src/a.ts#C")).toEqual({ reason: "pure DTO", category: "B" })
    expect(await callsOf(wrapped, "ts:src/a.ts#C")).toEqual(["withAuth", "inner"])
  })

  it("hints an empty function-valued field as an empty body", async () => {
    const source = classOf("  create = () => {}")

    expect(await hintOf(source, "ts:src/a.ts#C.create")).toEqual({
      reason: "empty body",
      category: "B",
    })
  })
})

describe("module-level function-valued variables are unchanged", () => {
  it("still extracts an arrow and a function expression as functions", async () => {
    const source = ["export const f = () => { a() }", "export const g = function () { b() }"].join(
      "\n",
    )
    const symbols = await symbolsOf(source)

    expect(symbols.map((s) => [s.id, s.kind, s.derivedBy])).toEqual([
      ["ts:src/a.ts#f", "function", ["variable-assigned-function", "export-keyword"]],
      ["ts:src/a.ts#g", "function", ["variable-assigned-function", "export-keyword"]],
    ])
  })

  it("still extracts any other initialiser as a const", async () => {
    const source = ["export const h = 1", "export const i = function* () { c() }"].join("\n")
    const symbols = await symbolsOf(source)

    expect(symbols.map((s) => [s.id, s.kind, s.derivedBy])).toEqual([
      ["ts:src/a.ts#h", "const", ["export-keyword"]],
      ["ts:src/a.ts#i", "const", ["export-keyword"]],
    ])
  })
})
