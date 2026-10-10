import { describe, expect, it } from "vitest"
import { CoreError, serializeCanonical } from "../src/index"

function compact(value: unknown): string {
  return serializeCanonical(value, { format: "compact" })
}

describe("serializeCanonical", () => {
  it("sorts object keys by code unit", () => {
    expect(compact({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}')
  })

  it("keeps array order", () => {
    expect(compact([3, 1, 2])).toBe("[3,1,2]")
  })

  it("writes structurally equal inputs to the same bytes, whatever their key order", () => {
    const a = serializeCanonical({ a: 1, b: { y: 2, x: 3 }, c: [{ q: 1, p: 2 }] })
    const b = serializeCanonical({ c: [{ p: 2, q: 1 }], b: { x: 3, y: 2 }, a: 1 })
    expect(a).toBe(b)
  })

  it("indents by two spaces and breaks lines with LF by default", () => {
    expect(serializeCanonical({ b: 1, a: { c: [1, 2] } })).toBe(
      '{\n  "a": {\n    "c": [\n      1,\n      2\n    ]\n  },\n  "b": 1\n}',
    )
  })

  it("writes an empty object and array bare, even in pretty mode", () => {
    expect(serializeCanonical({})).toBe("{}")
    expect(serializeCanonical([])).toBe("[]")
  })

  it("drops an entry whose value is undefined, as JSON.stringify does", () => {
    expect(compact({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}')
  })

  it("accepts an object with a null prototype", () => {
    expect(compact(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}')
  })

  it("round-trips through JSON.parse to a structurally equal value", () => {
    const value = { z: 1, a: { y: [1, 2, { q: "x", p: null }], b: true } }
    expect(JSON.parse(serializeCanonical(value))).toEqual(value)
  })

  class Custom {
    readonly value = 1
  }

  it.each<[string, unknown, string]>([
    ["a bigint", { x: 1n }, "$.x"],
    ["a function", { x: () => 0 }, "$.x"],
    ["a symbol", { x: Symbol("x") }, "$.x"],
    ["NaN", { x: Number.NaN }, "$.x"],
    ["Infinity", { x: Number.POSITIVE_INFINITY }, "$.x"],
    ["undefined inside an array", { x: [undefined] }, "$.x[0]"],
    ["a Map", { x: new Map() }, "$.x"],
    ["a Set", { x: new Set() }, "$.x"],
    ["a Date", { x: new Date(0) }, "$.x"],
    ["a class instance", { x: new Custom() }, "$.x"],
  ])("refuses %s rather than coercing it, naming where it sits", (_what, value, path) => {
    expect(() => compact(value)).toThrow(CoreError)
    expect(() => compact(value)).toThrowError(
      expect.objectContaining({ code: "non-plain-json", value: path }),
    )
  })
})
