import { describe, expect, it } from "vitest"
import { compareBy, compareCodeUnit, stringArraysEqual } from "../src/index"

describe("compareCodeUnit", () => {
  it.each([
    ["B", "a", -1],
    ["a", "a", 0],
    ["z", "caf\u00e9", 1],
    // Code point order puts the emoji after U+FFFD; its leading surrogate puts it before.
    ["\u{1F600}", "\uFFFD", -1],
  ])("compares %j with %j as %i, by UTF-16 code unit", (a, b, order) => {
    expect(compareCodeUnit(a, b)).toBe(order)
  })
})

describe("compareBy", () => {
  it("orders values by the string the key reads from each", () => {
    const values = [{ name: "b" }, { name: "C" }, { name: "a" }]

    expect(values.sort(compareBy((value) => value.name))).toEqual([
      { name: "C" },
      { name: "a" },
      { name: "b" },
    ])
  })
})

describe("stringArraysEqual", () => {
  it.each([
    [["a", "b"], ["a", "b"], true],
    [["a", "b"], ["b", "a"], false],
    [["a"], ["a", "a"], false],
    [[], [], true],
  ])("compares %j with %j position by position: %s", (a, b, equal) => {
    expect(stringArraysEqual(a, b)).toBe(equal)
  })
})
