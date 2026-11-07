import { describe, expect, it } from "vitest"
import { lastSegment } from "../src"

describe("lastSegment", () => {
  it.each([
    ["plain", "plain"],
    ["Cls.method", "method"],
    ["A.B.C.method", "method"],
    ["Cls::static", "static"],
    ["C::Inner.g", "g"],
    ["C::K::s", "s"],
    ["A.C::m", "m"],
    ["C.#v", "#v"],
    ["<default>", "<default>"],
  ])("gives %j the segment %j", (name, segment) => {
    expect(lastSegment(name)).toBe(segment)
  })

  it.each(["", "foo::", "A.", "::", "."])(
    "gives %j, which ends in no segment, the empty string",
    (name) => {
      expect(lastSegment(name)).toBe("")
    },
  )
})
