import type { BodyExtraction, DropHint, SymbolCandidate, WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { classifySymbolDropHint, extractSymbols, parseTypescriptFile, walkBody } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * A class member's written name and its qualified-name segment are two different things, and
 * the plugin used to treat them as one: it handed the name node's text to the id builder,
 * which throws on anything that is not an identifier. `class C { "ok"() {} }` and `class C {
 * 1() {} }` are legal TypeScript, and the throw cost the file every Symbol it had.
 *
 * A property key is a string. `"ok"() {}` and `ok() {}` declare the *same* property — `tsc`
 * calls the pair TS2300 — so the quoted spelling maps onto the `ok` segment and the two fold,
 * the way a field and a method of the same name already do. What is not an identifier once
 * decoded has no segment, and so no Symbol: its body stays on the class, which is the answer
 * `ir-schema.md` §3.2 already gives a computed name.
 */

const BACKSLASH = String.fromCharCode(92)

async function symbolsOf(source: string): Promise<SymbolCandidate<Node>[]> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  return extractSymbols(requireTree(result.tree), ctx)
}

async function idsOf(source: string): Promise<string[]> {
  return (await symbolsOf(source)).map((s) => s.id)
}

async function symbolOf(source: string, id: string): Promise<SymbolCandidate<Node>> {
  const symbols = await symbolsOf(source)
  const found = symbols.find((s) => s.id === id)
  if (found === undefined) {
    throw new Error(`no Symbol ${id}; have ${symbols.map((s) => s.id).join(", ")}`)
  }
  return found
}

async function walkOf(source: string, id: string): Promise<BodyExtraction> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.id === id)
  if (target === undefined) throw new Error(`no Symbol ${id} in fixture`)
  const walkCtx: WalkContext<Node> = { ...ctx, symbol: target }
  return walkBody(target, walkCtx)
}

async function callsOf(source: string, id: string): Promise<string[]> {
  return (await walkOf(source, id)).calls.map((c) => c.target)
}

async function hintOf(source: string, id: string): Promise<DropHint | null> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.id === id)
  if (target === undefined) throw new Error(`no Symbol ${id} in fixture`)
  return classifySymbolDropHint(target, ctx)
}

async function errorsOf(source: string): Promise<number> {
  return (await parseTypescriptFile({ path: "src/a.ts", content: source })).errors.length
}

function classOf(...members: string[]): string {
  return ["export class C {", ...members, "}"].join("\n")
}

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
    // The escape is decoded, so `"okay"` is `okay`. Reading the literal's text instead
    // would put the backslash and the four hex digits in the id.
    const source = classOf(`  "o${BACKSLASH}u006bay"() { s() }`)

    expect(await errorsOf(source)).toBe(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.okay"])
  })

  it("is one member with the bare spelling written beside it", async () => {
    // Two spellings of one property key, which is what `tsc` calls TS2300 — the same fold a
    // field and a method of the same name already get.
    const source = classOf("  ok() { a() }", '  "ok"() { b() }')

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.ok"])
    expect(await callsOf(source, "ts:src/a.ts#C.ok")).toEqual(["a", "b"])
    expect((await symbolOf(source, "ts:src/a.ts#C.ok")).derivedBy).toContain("declaration-merged")
  })

  it("pairs a quoted getter with a bare setter", async () => {
    const source = classOf('  get "v"() { g() }', "  set v(n) { s(n) }")
    const symbol = await symbolOf(source, "ts:src/a.ts#C.v")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.v"])
    // The getter leads, so the signature is what reading the property answers rather than the
    // setter's `(n)`.
    expect(symbol.signature?.inputs).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.v")).toEqual(["g", "s"])
  })

  it("declares one for a field holding a function", async () => {
    // The field gate used to refuse every name that was not written as an identifier, because
    // a name the id builder refuses was a lost file. Refusal is `null` now, so it does not
    // have to be stricter than the method gate.
    const source = classOf('  "ok" = () => { s() }')
    const symbol = await symbolOf(source, "ts:src/a.ts#C.ok")

    expect(symbol.kind).toBe("method")
    expect(symbol.derivedBy).toEqual(["class-method", "field-assigned-function"])
    expect(await callsOf(source, "ts:src/a.ts#C.ok")).toEqual(["s"])
  })

  it("reports the quoted spelling as public, and the private one as private", async () => {
    // `"#v"` decodes to `#v`, which is not a segment, so the two spellings never meet: a
    // quoted name is a public property whatever characters it holds.
    const source = classOf('  "v"() { a() }', "  #w() { b() }")

    expect((await symbolOf(source, "ts:src/a.ts#C.v")).visibility).toBe("public")
    expect((await symbolOf(source, "ts:src/a.ts#C.w")).visibility).toBe("private")
  })
})

describe("a name that is not an identifier has no Symbol, and the file keeps the rest", () => {
  it.each([
    ["a hyphen", '  "a-b"() { s() }'],
    // The shape that found this. The Standard Schema interface spells its members with a
    // leading `~` so they cannot collide with a library's own, which makes a quoted
    // non-identifier member a convention rather than a curiosity.
    ["a tilde", '  "~validate"() { s() }'],
    ["an integer", "  1() { s() }"],
    ["a decimal", "  1.5() { s() }"],
    ["nothing", '  ""() { s() }'],
    ["the instance separator", '  "a.b"() { s() }'],
    // A quoted `"#v"` is a public property whose characters begin with a `#`, and it decodes
    // to `#v`, which the grammar has no segment for. That it never earns a Symbol is what
    // keeps a member's *spelling* the only thing visibility has to read.
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
    // The shape this replaces: the whole file threw at the id builder and was named in
    // `stats.skippedFiles`, so `fine` went with it.
    const source = classOf('  "a-b"() { s() }', "  fine() { f() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.fine"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["s"])
    expect(await callsOf(source, "ts:src/a.ts#C.fine")).toEqual(["f"])
  })

  it("gets no Symbol when the literal itself did not parse", async () => {
    // `\uZZZZ` stands as an ERROR node beside the fragments, so joining what parsed would
    // answer `ok` — an id for a name the source does not contain, minted on top of the syntax
    // error already reported.
    const source = classOf(`  "o${BACKSLASH}uZZZZk"() { s() }`)

    expect(await errorsOf(source)).toBeGreaterThan(0)
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["s"])
  })
})

describe("the construction path is spelled two ways", () => {
  it("reads a quoted `constructor` as the constructor", async () => {
    // A class element whose property name is `constructor` is the constructor whatever the
    // spelling. Reading it as a method gave it the instance qname, where it collided with the
    // real constructor's.
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
    // The comparison is against the decoded segment, so a spelling that only *decodes* to
    // `constructor` is one too. Composing the two rules is not the same as pinning the pair.
    const source = classOf(`  "construc${BACKSLASH}u0074or"() { real() }`)
    const symbol = await symbolOf(source, "ts:src/a.ts#C.constructor")

    expect(symbol.kind).toBe("constructor")
  })

  it("refuses a quoted `constructor` field the way it refuses the bare one", async () => {
    // A field named `constructor` is a SyntaxError in an engine and parses here; its segment
    // is the one reserved for what `new C()` runs, and the quoted spelling reaches it too.
    const source = classOf("  real() { r() }", '  "constructor" = () => { c() }')

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.real"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["c"])
  })
})

describe("what the segment rule does not move", () => {
  it("still folds a private name into the public one written beside it", async () => {
    // `#` is not a character the qname grammar admits, so `#v` is spelled `v`. That is its own
    // open defect; decoding a quoted name does not touch it.
    const source = classOf("  v() { a() }", "  #v() { b() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.v"])
  })

  it("still leaves a computed name on the class", async () => {
    const source = classOf("  [k()]() { s() }")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["k", "s"])
  })

  it("does not turn a class into a DTO by refusing its only member a Symbol", async () => {
    // The drop-hint classifier reads what a member *is*, not whether it earned a Symbol — the
    // same reason a computed-name arrow field is behaviour rather than data.
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
