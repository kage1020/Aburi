import { describe, expect, it } from "vitest"
import { callsOf, classOf, hintOf, idsOf, symbolOf, symbolsOf } from "./fixtures/ctx"

/**
 * A member written as a field holding a function is a member. Constructing the class creates
 * the closure; the body is what *calling* it runs — so the body belongs to a Symbol of the
 * member's own, the way a `method_definition`'s does, and the class stops carrying it.
 *
 * `arrow_function` and `function_expression` are the set, mirroring the one
 * `makeVariableCandidate` reads at module level, so `const f = …` and `class C { f = … }`
 * answer the same question the same way. Whose body the walk records is pinned beside the
 * method spelling in `class-body-walk.test.ts`.
 */

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
    // The `#` is stripped from the qname segment, the way a `#`-private method's is: the
    // qualified-name grammar has no character for it. Which folds `#v` onto a `v` written
    // beside it, exactly as it does for two methods — the same defect, reached from a field.
    const symbol = await symbolOf(classOf("  #priv = () => { pv() }"), "ts:src/a.ts#C.priv")

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
    // The annotation names a type; only the arrow says what the parameters are called, so
    // `Handler` must not reach the signature in its place.
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
    // The scan walks back from the field, which is where a field's documentation is written —
    // above the whole member, outside the arrow.
    const source = classOf("  /** @throws {ValidationError} on a bad payload */", "  f = () => {}")
    const symbol = await symbolOf(source, "ts:src/a.ts#C.f")

    expect(symbol.signature?.throws).toEqual(["ValidationError"])
  })

  it("marks an auto-accessor field the way it marks a getter", async () => {
    // `accessor f = …` is a getter/setter pair over a hidden field. Without the token nothing
    // downstream can tell the pair from a plain field holding a function.
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
    // The member is declared where it is written. A decorator is inside the
    // `public_field_definition` and outside the arrow, so the two ranges differ by the line
    // it is on — which is what makes this readable at all.
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
    // A field's decorator is a `decorator:` **field child** of `public_field_definition`,
    // where a method's is a preceding sibling. `readDecorators` reads both positions.
    const symbol = await symbolOf(classOf("  @Inject() create = () => {}"), "ts:src/a.ts#C.create")

    expect(symbol.decorators.map((d) => d.name)).toEqual(["Inject"])
  })

  it("walks an expression-bodied arrow", async () => {
    // The most common spelling in the wild, and the one whose `body` field is not a
    // `statement_block`: the arrow's body is the expression itself.
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
    // Same rule the computed method follows: not a name static analysis can record, so no
    // Symbol — and the body has to stay somewhere.
    const source = classOf("  [key] = () => { comp() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["comp"])
  })

  it("takes a quoted name that spells an identifier, and leaves a numeric one", async () => {
    // The field gate is the method gate now: what decides is the *segment* the written name
    // maps to, so `"ok"` is the member `ok` and `1` is a `PropertyName` with no segment at
    // all. See `a-quoted-member-name.test.ts` for the rule itself.
    const source = classOf('  "ok" = () => { s() }', "  1 = () => { n() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.ok"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["n"])
    expect(await callsOf(source, "ts:src/a.ts#C.ok")).toEqual(["s"])
  })

  it("leaves a generator field on the class", async () => {
    // `function*` is outside the set at module level too (`const g = function* () {}` is a
    // `const`), and the two levels answer the same question with the same predicate.
    const source = classOf("  gen = function* () { yield g() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["g"])
  })

  it("refuses a field that spells the construction path", async () => {
    // A class field named `constructor` is a SyntaxError in an engine and parses here, and
    // its qname segment is the one reserved for what `new C()` runs. Admitting it would put a
    // field on `#C.constructor`, or fold it into a real constructor written beside it.
    const source = classOf(
      "  constructor() { real() }",
      "  constructor = () => { c1() }",
      "  #constructor = () => { c2() }",
    )

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.constructor"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["real", "c1", "c2"])
    expect(await callsOf(source, "ts:src/a.ts#C.constructor")).toEqual(["real"])
  })
})

describe("a field and a method of one name are one member", () => {
  it("folds a field and a method of the same name onto one member", async () => {
    // `tsc` calls this TS2300. The two candidates carry one id, so the sink folds them the way
    // it folds a getter and its setter, and the walk reads both bodies — the class carries
    // neither.
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
    // The hint asks the field's shape, not whether the member became a Symbol: this class has
    // exactly one Symbol and still declares behaviour rather than a shape.
    const source = classOf("  [key] = () => { x() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await hintOf(source, "ts:src/a.ts#C")).toBeNull()
  })

  it("reads a class of fields holding functions it does not recognise as one", async () => {
    // The recognised set is `arrow_function | function_expression`, and it is narrower than
    // "holds a function": a generator and a wrapped closure both fall to the data branch, so
    // the class is dropped and the calls it was carrying for them go with it. Pinned rather
    // than fixed here, because widening the set is the same decision at three sites at once —
    // this one, whether the member gets a Symbol, and whose body the walk records.
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
    // The member's `bodyNode` is the arrow's, so the empty-body rule sees the same thing it
    // sees on a method written `create() {}`.
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

    expect(symbols.map((s) => [s.id, s.kind])).toEqual([
      ["ts:src/a.ts#h", "const"],
      ["ts:src/a.ts#i", "const"],
    ])
  })
})
