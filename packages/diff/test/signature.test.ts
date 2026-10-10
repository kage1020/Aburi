import { sig } from "@aburi/test-support"
import type { Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { signatureSimilarity } from "../src"

const input = (type: string, name = "x") => ({ name, type })

describe("signatureSimilarity", () => {
  it.each<[string, Signature | null | undefined, Signature | null | undefined, number]>([
    ["two absent signatures as identical", null, null, 1],
    ["an undefined signature as an absent one", undefined, null, 1],
    ["an absent signature against a present one as nothing", null, sig(), 0],
    ["a present signature against an absent one as nothing", sig(), undefined, 0],
    [
      "identical signatures as identical",
      sig({ inputs: [input("string")] }),
      sig({ inputs: [input("string")] }),
      1,
    ],
    [
      "inputs by type alone, whatever they are named",
      sig({ inputs: [input("string", "a")] }),
      sig({ inputs: [input("string", "b")] }),
      1,
    ],
    [
      "inputs by the share of positions whose type agrees",
      sig({ inputs: [input("string"), input("number")] }),
      sig({ inputs: [input("string"), input("string")] }),
      (0.5 + 1 + 1) / 3,
    ],
    [
      "inputs of differing count as disagreeing outright",
      sig({ inputs: [input("string")] }),
      sig({ inputs: [input("string"), input("number")] }),
      (0 + 1 + 1) / 3,
    ],
    [
      "an empty output list against a present one as disagreeing",
      sig({ outputs: [] }),
      sig(),
      (1 + 0 + 1) / 3,
    ],
    [
      "throws as a set, by Jaccard",
      sig({ throws: ["AuthError", "RateLimitError"] }),
      sig({ throws: ["RateLimitError", "TimeoutError"] }),
      (1 + 1 + 1 / 3) / 3,
    ],
  ])("scores %s", (_, base, head, expected) => {
    expect(signatureSimilarity(base, head)).toBeCloseTo(expected, 10)
  })
})
