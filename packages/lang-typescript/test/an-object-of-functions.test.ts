import { describe, expect, it } from "vitest"
import { BACKSLASH, callsOf, hintOf, symbolOf, symbolsOf, walkOf } from "./fixtures/ctx"

/**
 * A function an object literal holds is a member of the binding that holds the object.
 * Defining the object creates the closure and does not enter it; the body is what calling the
 * property runs — so it belongs to a Symbol of its own, `api.get`, and the binding keeps only
 * what defining the object runs. That is LP20a and LP20f read for an object rather than a class,
 * and the name gate is the class member's.
 */

const API = [
  "export const api = {",
  "  client: makeClient(),",
  '  get: async () => fetch("/x"),',
  "  post() { send() },",
  "}",
].join("\n")

const idsOf = async (source: string, path?: string) =>
  (await symbolsOf(source, path)).map((symbol) => symbol.id)

describe("a function an object literal holds is a member Symbol", () => {
  it("declares one for a property holding an arrow and one for a method", async () => {
    expect(await idsOf(API)).toEqual([
      "ts:src/a.ts#api",
      "ts:src/a.ts#api.get",
      "ts:src/a.ts#api.post",
    ])
  })

  it("names the property spelling apart from the method spelling only in derivedBy", async () => {
    const get = await symbolOf(API, "ts:src/a.ts#api.get")
    const post = await symbolOf(API, "ts:src/a.ts#api.post")

    expect([get.kind, get.derivedBy]).toEqual([
      "method",
      ["object-method", "property-assigned-function"],
    ])
    expect([post.kind, post.derivedBy]).toEqual(["method", ["object-method"]])
  })

  it("keeps the binding a const, and says why it has a body", async () => {
    const api = await symbolOf(API, "ts:src/a.ts#api")

    expect(api.kind).toBe("const")
    expect(api.signature).toBeNull()
    expect(api.derivedBy).toEqual(["object-literal-initializer", "export-keyword"])
  })

  it("puts each body on its member and what defining the object runs on the binding", async () => {
    expect(await callsOf(API, "ts:src/a.ts#api.get")).toEqual(["fetch"])
    expect(await callsOf(API, "ts:src/a.ts#api.post")).toEqual(["send"])
    expect(await callsOf(API, "ts:src/a.ts#api")).toEqual(["makeClient"])
  })

  it("keeps a member's rules off the binding", async () => {
    const source = "export const api = { post(x: unknown) { if (!x) return; send(x) } }"

    expect((await walkOf(source, "ts:src/a.ts#api.post")).rules.map((r) => r.type)).toEqual([
      "guard",
    ])
    expect((await walkOf(source, "ts:src/a.ts#api")).rules).toEqual([])
  })

  it("reads a concise arrow's body as its return value, as for any walk root", async () => {
    const source = 'export const can = { admin: (u: any) => u.role === "admin" }'

    expect((await walkOf(source, "ts:src/a.ts#can.admin")).rules).toMatchObject([
      { type: "return", expr: 'u.role === "admin"' },
    ])
  })

  it("puts a member's parameter defaults on the member, not on the binding", async () => {
    const source = "export const api = { post(d = dflt()) { send(d) }, get: (q = dq()) => q }"

    expect(await callsOf(source, "ts:src/a.ts#api.post")).toEqual(["dflt", "send"])
    expect(await callsOf(source, "ts:src/a.ts#api.get")).toEqual(["dq"])
    expect(await callsOf(source, "ts:src/a.ts#api")).toEqual([])
  })

  it.each([
    ["a function expression", "  f: function (a: number) { q(a) },"],
    ["an async method", "  async f(a: number) { q(a) },"],
    ["a generator method", "  *f(a: number) { yield q(a) },"],
    ["a wrapped arrow", "  f: ((a: number) => { q(a) }) as H,"],
  ])("declares one for %s", async (_label, entry) => {
    const source = ["export const api = {", entry, "}"].join("\n")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#api", "ts:src/a.ts#api.f"])
    expect(await callsOf(source, "ts:src/a.ts#api.f")).toEqual(["q"])
    expect(await callsOf(source, "ts:src/a.ts#api")).toEqual([])
  })

  it("reads a method named get or set as a method, not an accessor", async () => {
    const source = "export const o = { get(k: string) { a(k) }, set(k: string) { b(k) } }"

    expect((await symbolOf(source, "ts:src/a.ts#o.get")).derivedBy).toEqual(["object-method"])
    expect((await symbolOf(source, "ts:src/a.ts#o.set")).derivedBy).toEqual(["object-method"])
  })

  it("takes the signature from the function", async () => {
    const source = "export const api = { get: (id: string, n: number) => id }"
    const symbol = await symbolOf(source, "ts:src/a.ts#api.get")

    expect(symbol.signature?.inputs.map((i) => [i.name, i.type])).toEqual([
      ["id", "string"],
      ["n", "number"],
    ])
  })

  it("reads the JSDoc written above the entry", async () => {
    const source = [
      "export const api = {",
      "  n: 1,",
      "  /** @throws {NotFound} when the id is unknown */",
      "  get: (id: string) => id,",
      "}",
    ].join("\n")

    expect((await symbolOf(source, "ts:src/a.ts#api.get")).signature?.throws).toEqual(["NotFound"])
  })

  it("reports the entry's own range, not the function's", async () => {
    // The member is declared where its name is written, and a key on a line of its own is the
    // one spelling that puts the two ranges on different lines.
    const source = ["export const api = {", "  get:", "    () => {", "      q()", "    },", "}"]
    const { source: range } = await symbolOf(source.join("\n"), "ts:src/a.ts#api.get")

    expect([range.startLine, range.endLine]).toEqual([2, 5])
  })

  it("is public whether or not the binding is exported, as a class member is", async () => {
    const source = "const api = { get: () => q() }"

    expect((await symbolOf(source, "ts:src/a.ts#api")).visibility).toBe("internal")
    expect((await symbolOf(source, "ts:src/a.ts#api.get")).visibility).toBe("public")
  })

  it.each([
    "src/a.ts",
    "src/a.tsx",
    "src/a.js",
    "src/a.jsx",
    "src/a.mts",
  ])("declares one in %s", async (path) => {
    expect(await idsOf("export const api = { get: () => q() }", path)).toEqual([
      `ts:${path}#api`,
      `ts:${path}#api.get`,
    ])
  })
})

describe("the binding an object is read under", () => {
  it.each([
    ["`as const`", "export const api = { get: () => q() } as const"],
    ["`satisfies`", "export const api = { get: () => q() } satisfies Api"],
    ["parentheses", "export const api = ({ get: () => q() })"],
    ["`let`", "export let api = { get: () => q() }"],
    ["`var`", "export var api = { get: () => q() }"],
  ])("reads through %s", async (_label, source) => {
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#api", "ts:src/a.ts#api.get"])
    expect(await callsOf(source, "ts:src/a.ts#api.get")).toEqual(["q"])
  })

  it("reads every declarator of one statement", async () => {
    expect(await idsOf("const a = { f() {} }, b = { g: () => {} }")).toEqual([
      "ts:src/a.ts#a",
      "ts:src/a.ts#a.f",
      "ts:src/a.ts#b",
      "ts:src/a.ts#b.g",
    ])
  })

  it("names a member under the namespace the binding is in", async () => {
    expect(await idsOf("namespace N { export const h = { x: () => q() } }")).toEqual([
      "ts:src/a.ts#N",
      "ts:src/a.ts#N.h",
      "ts:src/a.ts#N.h.x",
    ])
  })

  it("names an exported binding of a namespace merged into a class on the static side", async () => {
    const source = "export class C {}\nexport namespace C { export const api = { get() { q() } } }"

    expect(await idsOf(source)).toContain("ts:src/a.ts#C::api.get")
  })

  it("promotes only the binding when a separate export default names it", async () => {
    const source = "const api = { get: () => q() }\nexport default api"

    expect((await symbolOf(source, "ts:src/a.ts#api")).derivedBy).toContain("export-default")
    expect((await symbolOf(source, "ts:src/a.ts#api.get")).derivedBy).not.toContain(
      "export-default",
    )
  })
})

describe("an object written inside the object", () => {
  const NESTED = [
    "export const api = {",
    "  v1: {",
    "    get: () => { one() },",
    "    deeper: { leaf() { two() } },",
    "  },",
    "}",
  ].join("\n")

  it("declares its members one segment further down, at any depth", async () => {
    expect(await idsOf(NESTED)).toEqual([
      "ts:src/a.ts#api",
      "ts:src/a.ts#api.v1.deeper.leaf",
      "ts:src/a.ts#api.v1.get",
    ])
  })

  it("leaves no member body on the binding", async () => {
    expect(await callsOf(NESTED, "ts:src/a.ts#api")).toEqual([])
    expect(await callsOf(NESTED, "ts:src/a.ts#api.v1.get")).toEqual(["one"])
    expect(await callsOf(NESTED, "ts:src/a.ts#api.v1.deeper.leaf")).toEqual(["two"])
  })

  it("keeps the values a nested object evaluates on the binding", async () => {
    const source = "export const api = { v1: { client: make(), get: () => q() } }"

    expect(await callsOf(source, "ts:src/a.ts#api")).toEqual(["make"])
  })

  it("reads a nested object through a wrapper", async () => {
    const source = "export const api = { v1: { get: () => q() } as const }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#api", "ts:src/a.ts#api.v1.get"])
  })

  it("mints nothing for a configuration object that holds no function", async () => {
    const source = 'export const config = { db: { host: "h", port: 5432 }, retries: 3 }'

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#config"])
  })

  it("leaves an object under a computed key to the binding, functions and all", async () => {
    const source = "export const api = { [k]: { get: () => { q() } } }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#api"])
    expect(await callsOf(source, "ts:src/a.ts#api")).toEqual(["q"])
  })
})

describe("the name gate is a class member's", () => {
  it("decodes a quoted key that spells an identifier", async () => {
    const source = 'export const api = { "get": () => q() }'

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#api", "ts:src/a.ts#api.get"])
  })

  it.each([
    ["a computed key", "[k]: () => { q() }"],
    ["a computed method", "[k]() { q() }"],
    ["a quoted key that is not an identifier", '"a-b": () => { q() }'],
    ["a numeric key", "1: () => { q() }"],
    ["a private name, which an object literal cannot have", "#p() { q() }"],
    ["a private name on a property", "#p: () => { q() }"],
    ["a key the parser recovered", `"${BACKSLASH}uZZZZ": () => { q() }`],
  ])("gives %s no Symbol and leaves its body on the binding", async (_label, entry) => {
    const source = `export const api = { ${entry} }`

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#api"])
    expect(await callsOf(source, "ts:src/a.ts#api")).toEqual(["q"])
  })
})

describe("entries that are not members", () => {
  it.each([
    ["a value", "n: q()", ["q"]],
    ["a function handed to a call", "h: withAuth(() => { q() })", ["withAuth", "q"]],
    ["a generator function", "g: function* () { yield q() }", ["q"]],
    ["a function in an array", "hs: [() => { q() }]", ["q"]],
    ["a shorthand", "q", []],
    ["a spread", "...q()", ["q"]],
  ])("leaves %s on the binding", async (_label, entry, calls) => {
    const source = `export const api = { ${entry} }`

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#api"])
    expect(await callsOf(source, "ts:src/a.ts#api")).toEqual(calls)
  })
})

describe("one member written twice", () => {
  it("folds an accessor pair into one Symbol, led by the getter", async () => {
    const source = [
      "export const o = {",
      "  set v(n: number) { sv(n) },",
      "  get v(): number { return gv() },",
      "}",
    ].join("\n")
    const symbol = await symbolOf(source, "ts:src/a.ts#o.v")

    expect(symbol.derivedBy).toEqual([
      "object-method",
      "accessor-declaration",
      "declaration-merged",
    ])
    expect(symbol.signature?.inputs).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#o.v")).toEqual(["sv", "gv"])
  })

  it("folds a repeated key into one Symbol", async () => {
    const source = "export const o = { a() { one() }, a: () => { two() } }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#o", "ts:src/a.ts#o.a"])
    expect((await symbolOf(source, "ts:src/a.ts#o.a")).derivedBy).toContain("declaration-merged")
    expect(await callsOf(source, "ts:src/a.ts#o.a")).toEqual(["one", "two"])
  })
})

describe("a member's drop hint is a method's", () => {
  it("hints an empty member body", async () => {
    expect(await hintOf("export const o = { onClose() {} }", "ts:src/a.ts#o.onClose")).toEqual({
      reason: "empty body",
      category: "B",
    })
  })

  it("hints nothing on the binding", async () => {
    expect(await hintOf("export const o = { onClose() {} }", "ts:src/a.ts#o")).toBeNull()
  })
})

describe("what an object member does not reach", () => {
  it.each([
    ["an object handed to a call", "export const c = Object.freeze({ m() { q() } })", "c"],
    ["an object in an array", "export const routes = [{ handler() { q() } }]", "routes"],
    [
      "an object a destructuring declaration reads",
      "export const { m } = { m: () => { q() } }",
      "m",
    ],
  ])("declares no member for %s", async (_label, source, name) => {
    expect(await idsOf(source)).toEqual([`ts:src/a.ts#${name}`])
    expect(await callsOf(source, `ts:src/a.ts#${name}`)).toEqual([])
  })

  it("declares nothing for an object that is the default export", async () => {
    // `<default>.fetch` is not a qualified name, as `<default>.m` is not for an anonymous class.
    expect(await idsOf("export default { fetch() { q() } }")).toEqual([])
  })

  it("declares nothing for an object assigned to module.exports", async () => {
    expect(await idsOf("module.exports = { m() { q() } }", "src/a.js")).toEqual([])
  })

  it("leaves an object a class field holds on the class", async () => {
    const source = "export class C { handlers = { get() { q() } } }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["q"])
  })
})
