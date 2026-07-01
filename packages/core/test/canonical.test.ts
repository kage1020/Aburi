import { describe, expect, it } from "vitest"
import { CoreError, serializeCanonical } from "../src/index"

describe("serializeCanonical", () => {
  it("sorts object keys by Unicode codepoint", () => {
    const out = serializeCanonical({ z: 1, a: 2, m: 3 }, { format: "compact" })
    expect(out).toBe('{"a":2,"m":3,"z":1}')
  })

  it("preserves array order (no sort)", () => {
    expect(serializeCanonical([3, 1, 2], { format: "compact" })).toBe("[3,1,2]")
  })

  it("normalizes strings to NFC (composed é equals decomposed é)", () => {
    const composed = "café"
    const decomposed = "café"
    expect(serializeCanonical(composed, { format: "compact" })).toBe(
      serializeCanonical(decomposed, { format: "compact" }),
    )
  })

  it("emits 2-space indent + LF in pretty mode", () => {
    const out = serializeCanonical({ b: 1, a: { c: [1, 2] } })
    expect(out).toBe('{\n  "a": {\n    "c": [\n      1,\n      2\n    ]\n  },\n  "b": 1\n}')
    expect(out.includes("\r\n")).toBe(false)
  })

  it("is byte-identical for two structurally equal inputs in different key order", () => {
    const a = serializeCanonical({ a: 1, b: { y: 2, x: 3 }, c: [{ q: 1, p: 2 }] })
    const b = serializeCanonical({ c: [{ p: 2, q: 1 }], b: { x: 3, y: 2 }, a: 1 })
    expect(a).toBe(b)
  })

  it("strips undefined entries (matches JSON.stringify behavior)", () => {
    expect(serializeCanonical({ a: 1, b: undefined, c: 2 }, { format: "compact" })).toBe(
      '{"a":1,"c":2}',
    )
  })

  it("rejects bigint values", () => {
    expect(() => serializeCanonical({ x: 1n }, { format: "compact" })).toThrowError(
      expect.objectContaining({ code: "non-plain-json" }),
    )
  })

  it("rejects function values", () => {
    expect(() => serializeCanonical({ x: () => 0 }, { format: "compact" })).toThrowError(
      expect.objectContaining({ code: "non-plain-json" }),
    )
  })

  it("rejects symbol values", () => {
    expect(() => serializeCanonical({ x: Symbol("x") }, { format: "compact" })).toThrowError(
      expect.objectContaining({ code: "non-plain-json" }),
    )
  })

  it("rejects class instances (Map, Set, Date, custom)", () => {
    class Custom {
      readonly value = 1
    }
    for (const obj of [new Map(), new Set(), new Date(0), new Custom()]) {
      let caught: unknown
      try {
        serializeCanonical(obj)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(CoreError)
      expect((caught as CoreError).code).toBe("non-plain-json")
    }
  })

  it("rejects NaN and Infinity", () => {
    expect(() => serializeCanonical({ x: NaN }, { format: "compact" })).toThrowError(
      expect.objectContaining({ code: "non-plain-json" }),
    )
    expect(() => serializeCanonical({ x: Infinity }, { format: "compact" })).toThrowError(
      expect.objectContaining({ code: "non-plain-json" }),
    )
  })

  it("emits empty object and array compactly even in pretty mode", () => {
    expect(serializeCanonical({})).toBe("{}")
    expect(serializeCanonical([])).toBe("[]")
  })

  it("round-trips through JSON.parse to a structurally equal value", () => {
    const value = { z: 1, a: { y: [1, 2, { q: "café", p: null }], b: true } }
    const text = serializeCanonical(value)
    expect(JSON.parse(text)).toEqual({
      a: { b: true, y: [1, 2, { p: null, q: "café".normalize("NFC") }] },
      z: 1,
    })
  })
})
