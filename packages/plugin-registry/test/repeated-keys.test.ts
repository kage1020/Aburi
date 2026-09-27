import { describe, expect, it } from "vitest"
import { describeRepeatedKey, type RepeatedKey, scanKeys } from "../src/repeated-keys"

describe("scanKeys", () => {
  it("is clean when every object names each key once", () => {
    expect(scanKeys(`{ "a": { "b": 1 }, "c": [{ "b": 2 }] }`)).toEqual({ kind: "clean" })
  })

  it("stops at the first repeat, not the last", () => {
    expect(scanKeys(`{ "a": 1, "a": 2, "b": 1, "b": 2 }`)).toEqual({
      kind: "repeated",
      key: "a",
      owner: [],
      line: 1,
      column: 11,
      offset: 10,
      length: 3,
    })
  })

  it("keeps an object's keys apart from its parent's", () => {
    expect(scanKeys(`{ "a": { "a": 1 } }`)).toEqual({ kind: "clean" })
    expect(scanKeys(`{ "a": { "b": 1 }, "b": 2 }`)).toEqual({ kind: "clean" })
  })

  it("restores the parent's keys after a child object closes", () => {
    expect(scanKeys(`{ "a": { "b": 1 }, "c": 1, "c": 2 }`)).toMatchObject({
      key: "c",
      owner: [],
      column: 28,
    })
    expect(scanKeys(`{ "a": [{ "b": 1 }], "c": 1, "c": 2 }`)).toMatchObject({
      key: "c",
      owner: [],
      column: 30,
    })
  })

  it("compares keys as decoded, not as written", () => {
    // The second key is written as a six-character unicode escape of "a".
    const escaped = `{ "a": 1, "${"\\"}u0061": 2 }`
    expect(escaped).toHaveLength(23)
    expect(scanKeys(escaped)).toMatchObject({ kind: "repeated", key: "a" })
  })

  it("reports __proto__ the first time, at any depth", () => {
    expect(scanKeys(`{ "a": [{ "__proto__": 1 }] }`)).toMatchObject({
      kind: "prototype-key",
      key: "__proto__",
      owner: ["a", 0],
    })
  })

  it.each([
    `{ "a": 1 } { "b": 2, "b": 3 }`,
    `{{ "a": 1, "a": 2 }}`,
    `{ "a": [1, 2 , "b": 3, "b": 4 }`,
  ])("calls %s unreadable rather than clean", (text) => {
    expect(scanKeys(text)).toEqual({ kind: "unreadable" })
  })
})

describe("describeRepeatedKey", () => {
  const at = { line: 2, column: 5, offset: 0, length: 0 }

  it("says twice for a repeat, naming the subject it is given", () => {
    const found: RepeatedKey = {
      kind: "repeated",
      key: "id",
      owner: ["provides", "effects", 0],
      ...at,
    }
    expect(describeRepeatedKey(found, "Manifest at m.json")).toBe(
      'Manifest at m.json names "id" twice in /provides/effects/0 (again at line 2, column 5)',
    )
  })

  it("escapes a key holding / or ~ as JSON Pointer does, so no two owners read alike", () => {
    const found: RepeatedKey = { kind: "repeated", key: "x", owner: ["a/b", "c~d", ""], ...at }
    expect(describeRepeatedKey(found, "S")).toBe(
      'S names "x" twice in /a~1b/c~0d/ (again at line 2, column 5)',
    )
  })

  it("explains __proto__ by what the parser does with it", () => {
    const found: RepeatedKey = { kind: "prototype-key", key: "__proto__", owner: [], ...at }
    expect(describeRepeatedKey(found, "S")).toBe(
      'S names "__proto__" as a key in the top-level object (at line 2, column 5); the parser ' +
        "assigns it instead of defining it, so it never becomes a key the schema can see",
    )
  })
})
