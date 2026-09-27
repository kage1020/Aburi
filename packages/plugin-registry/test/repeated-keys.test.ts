import { describe, expect, it } from "vitest"
import { findRepeatedKey } from "../src/index"

const OPTIONS = { allowTrailingComma: true, disallowComments: false }

describe("findRepeatedKey", () => {
  it("returns null for a text that names each key once per object", () => {
    expect(findRepeatedKey(`{ "a": { "b": 1 }, "c": [{ "b": 2 }] }`, OPTIONS)).toBeNull()
  })

  it("stops at the first repeat, not the last", () => {
    expect(findRepeatedKey(`{ "a": 1, "a": 2, "b": 1, "b": 2 }`, OPTIONS)).toEqual({
      key: "a",
      path: [],
      line: 1,
      column: 11,
    })
  })

  it("keeps an object's keys apart from its parent's", () => {
    expect(findRepeatedKey(`{ "a": { "a": 1 } }`, OPTIONS)).toBeNull()
    expect(findRepeatedKey(`{ "a": { "b": 1 }, "b": 2 }`, OPTIONS)).toBeNull()
  })
})
