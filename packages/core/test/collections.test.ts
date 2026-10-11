import { describe, expect, it } from "vitest"
import { countBy, groupBy } from "../src/index"

const words = ["beta", "apple", "bravo", "avocado", "cherry"]

describe("groupBy", () => {
  it("buckets items in first-seen key order, each bucket in input order", () => {
    expect([...groupBy(words, (word) => word[0])]).toEqual([
      ["b", ["beta", "bravo"]],
      ["a", ["apple", "avocado"]],
      ["c", ["cherry"]],
    ])
  })
})

describe("countBy", () => {
  it("counts items per key, in first-seen key order", () => {
    expect([...countBy(words, (word) => word[0])]).toEqual([
      ["b", 2],
      ["a", 2],
      ["c", 1],
    ])
  })
})
