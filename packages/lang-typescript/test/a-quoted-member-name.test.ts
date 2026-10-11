import { describe, expect, it } from "vitest"
import { BACKSLASH, callsOf, classOf, hintOf, idsOf, parseErrorsOf, symbolOf } from "./fixtures/ctx"

const errorsOf = async (source: string) => (await parseErrorsOf(source)).length

describe("a quoted name that spells an identifier is that member", () => {
  it("declares a Symbol of its own", async () => {
    const source = classOf('  "ok"() { s() }')

    expect(await errorsOf(source)).toBe(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.ok"])
    expect(await callsOf(source, "ts:src/a.ts#C.ok")).toEqual(["s"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
  })

  it("keeps the static separator", async () => {
    expect(await idsOf(classOf('  static "ok"() { s() }'))).toEqual([
      "ts:src/a.ts#C",
      "ts:src/a.ts#C::ok",
    ])
  })

  it("names the member the source names, not the source text", async () => {
    const source = classOf(`  "o${BACKSLASH}u006bay"() { s() }`)

    expect(await errorsOf(source)).toBe(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.okay"])
  })

  it("is one member with the bare spelling written beside it", async () => {
    const source = classOf("  ok() { a() }", '  "ok"() { b() }')

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.ok"])
    expect(await callsOf(source, "ts:src/a.ts#C.ok")).toEqual(["a", "b"])
    expect((await symbolOf(source, "ts:src/a.ts#C.ok")).derivedBy).toContain("declaration-merged")
  })

  it("pairs a quoted getter with a bare setter", async () => {
    const source = classOf('  get "v"() { g() }', "  set v(n) { s(n) }")
    const symbol = await symbolOf(source, "ts:src/a.ts#C.v")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.v"])
    expect(symbol.signature?.inputs).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.v")).toEqual(["g", "s"])
  })

  it("takes the single-quoted spelling too", async () => {
    expect(await idsOf(classOf("  'ok'() { s() }"))).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.ok"])
  })

  it("declares one for a field holding a function", async () => {
    const source = classOf('  "ok" = () => { s() }')

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.ok"])
    expect(await callsOf(source, "ts:src/a.ts#C.ok")).toEqual(["s"])
  })

  it("names a quoted auto-accessor field by its segment too", async () => {
    expect(await idsOf(classOf('  accessor "ok" = () => { s() }'))).toEqual([
      "ts:src/a.ts#C",
      "ts:src/a.ts#C.ok",
    ])
  })

  it("reports the quoted spelling as public, and the private one as private", async () => {
    const source = classOf('  "v"() { a() }', "  #v() { b() }")

    expect((await symbolOf(source, "ts:src/a.ts#C.v")).visibility).toBe("public")
    expect((await symbolOf(source, "ts:src/a.ts#C.#v")).visibility).toBe("private")
  })

  it("never reads a quoted `#` as the private name", async () => {
    const source = classOf('  "#v"() { a() }', "  #v() { b() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.#v"])
    expect(await callsOf(source, "ts:src/a.ts#C.#v")).toEqual(["b"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["a"])
  })
})

describe("a name that is not an identifier has no Symbol, and the file keeps the rest", () => {
  it.each([
    ["a hyphen", '  "a-b"() { s() }'],
    ["a tilde", '  "~validate"() { s() }'],
    ["an integer", "  1() { s() }"],
    ["a decimal", "  1.5() { s() }"],
    ["nothing", '  ""() { s() }'],
    ["the instance separator", '  "a.b"() { s() }'],
    ["a private-looking string", '  "#v"() { s() }'],
    ["a hyphenated field", '  "a-b" = () => { s() }'],
    ["a numeric field", "  1 = () => { s() }"],
  ])("leaves %s on the class", async (_label, member) => {
    const source = classOf(member)

    expect(await errorsOf(source)).toBe(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["s"])
  })

  it("keeps the members written beside it", async () => {
    const source = classOf('  "a-b"() { s() }', "  fine() { f() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.fine"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["s"])
    expect(await callsOf(source, "ts:src/a.ts#C.fine")).toEqual(["f"])
  })

  it("gets no Symbol when the literal itself did not parse", async () => {
    const source = classOf(`  "o${BACKSLASH}uZZZZk"() { s() }`)

    expect(await errorsOf(source)).toBeGreaterThan(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["s"])
  })

  it("gets no Symbol when the literal did not parse at all", async () => {
    const source = classOf(`  "${BACKSLASH}uZZZZ"() { s() }`)

    expect(await errorsOf(source)).toBeGreaterThan(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["s"])
  })

  it("keeps a member whose body did not parse", async () => {
    const source = classOf("  m() { s(( }")

    expect(await errorsOf(source)).toBeGreaterThan(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.m"])
  })

  it("leaves a bare identifier written with an escape on the class", async () => {
    const source = classOf(`  o${BACKSLASH}u006bay() { s() }`)

    expect(await errorsOf(source)).toBe(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["s"])
  })
})

describe("the construction path is spelled two ways", () => {
  it("reads a quoted `constructor` as the constructor", async () => {
    const source = classOf('  "constructor"() { real() }')
    const symbol = await symbolOf(source, "ts:src/a.ts#C.constructor")

    expect(symbol.kind).toBe("constructor")
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.constructor"])
  })

  it("folds the two spellings rather than colliding", async () => {
    const source = classOf("  constructor() { r() }", '  "constructor"() { q() }')

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.constructor"])
    expect(await callsOf(source, "ts:src/a.ts#C.constructor")).toEqual(["r", "q"])
  })

  it("reaches it through an escape as well", async () => {
    const source = classOf(`  "construc${BACKSLASH}u0074or"() { real() }`)
    const symbol = await symbolOf(source, "ts:src/a.ts#C.constructor")

    expect(symbol.kind).toBe("constructor")
  })

  it("refuses a quoted `constructor` field the way it refuses the bare one", async () => {
    const source = classOf("  real() { r() }", '  "constructor" = () => { c() }')

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.real"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["c"])
  })

  it("leaves a quoted `constructor` off the path when it is static", async () => {
    const source = classOf("  constructor() { r() }", '  static "constructor"() { s() }')

    expect(await idsOf(source)).toEqual([
      "ts:src/a.ts#C",
      "ts:src/a.ts#C.constructor",
      "ts:src/a.ts#C::constructor",
    ])
    expect((await symbolOf(source, "ts:src/a.ts#C::constructor")).kind).toBe("method")
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["r"])
  })

  it("leaves a `#`-private `constructor` off the path", async () => {
    const source = classOf("  #constructor() { s() }")
    const symbol = await symbolOf(source, "ts:src/a.ts#C.#constructor")

    expect(symbol.kind).toBe("method")
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.#constructor")).toEqual(["s"])
  })
})

describe("what the segment rule does not move", () => {
  it("does not turn a class into a DTO by refusing its only member a Symbol", async () => {
    expect(await hintOf(classOf('  "a-b"() { s() }'), "ts:src/a.ts#C")).toBeNull()
    expect(await hintOf(classOf('  "a-b" = () => { s() }'), "ts:src/a.ts#C")).toBeNull()
  })

  it("still reads a quoted field holding a literal as data", async () => {
    expect(await hintOf(classOf('  "a-b" = 1'), "ts:src/a.ts#C")).toEqual({
      reason: "pure DTO",
      category: "B",
    })
  })
})
