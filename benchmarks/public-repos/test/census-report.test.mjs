import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  callSiteKey,
  drawIndices,
  isTestPath,
  parseCensusArgs,
  renderCheck,
  renderShares,
  stratifiedShare,
  wilsonInterval,
} from "../census-report.mjs"

function repo(id, noMatch) {
  return { id, head: "0".repeat(40), calls: 1000, resolved: 100, unresolved: { noMatch } }
}

function sample(overrides = {}) {
  return {
    repo: "a",
    file: "src/a.ts",
    line: 1,
    symbol: "ts:src/a.ts#f",
    target: "g",
    test: false,
    category: "rule",
    expected: "external",
    note: null,
    ...overrides,
  }
}

function census(samples, repos = [repo("a", 100)]) {
  return {
    repos,
    categories: {
      rule: { needsTypes: false, definition: "", rule: "" },
      typed: { needsTypes: true, definition: "", rule: null },
    },
    samples,
  }
}

function rowOf(markdown, label) {
  return markdown
    .split("\n")
    .find((line) => line.startsWith(`| ${label} |`))
    ?.split(" | ")
    .slice(1)
}

describe("parseCensusArgs", () => {
  it.each([
    [[], /first argument is the mode/],
    [["sample"], /first argument is the mode/],
    [["shares", "--work-dir", "/tmp/w"], /Unknown flag for `shares`/],
    [["check", "--seed", "x"], /Unknown flag for `check`/],
    [["draw", "--per-repo", "0"], /at least 1/],
    [["draw", "--per-repo", "2.5"], /at least 1/],
    [["draw", "--only"], /needs a value/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseCensusArgs(argv)).toThrow(message)
  })

  it("reads the draw's flags and resolves the work directory", () => {
    const options = parseCensusArgs([
      "draw",
      "--only",
      "zod,nest",
      "--per-repo",
      "20",
      "--seed",
      "s",
      "--work-dir",
      "/tmp/w",
    ])
    expect(options).toMatchObject({
      mode: "draw",
      only: ["zod", "nest"],
      perRepo: 20,
      seed: "s",
      workDir: resolve("/tmp/w"),
    })
  })
})

describe("drawIndices", () => {
  it("draws the same indices for the same seed, and others for another seed", () => {
    expect(drawIndices(1000, 25, "no-match:zod")).toEqual(drawIndices(1000, 25, "no-match:zod"))
    expect(drawIndices(1000, 25, "no-match:zod")).not.toEqual(
      drawIndices(1000, 25, "no-match:hono"),
    )
  })

  it("draws without replacement, in index order, inside the population", () => {
    const drawn = drawIndices(80, 75, "seed")
    expect(new Set(drawn).size).toBe(75)
    expect(drawn).toEqual([...drawn].sort((a, b) => a - b))
    expect(drawn.every((index) => index >= 0 && index < 80)).toBe(true)
  })

  it("takes the whole population when it is smaller than the sample", () => {
    expect(drawIndices(3, 75, "seed")).toEqual([0, 1, 2])
  })
})

describe("isTestPath", () => {
  it.each([
    ["src/router/common.case.test.ts", true],
    ["packages/zod/src/v3/tests/Mocker.ts", true],
    ["src/__tests__/server.ts", true],
    ["integration/hello-world/e2e/middleware.spec.ts", true],
    ["packages/bench/compile.bench.ts", true],
    ["src/types.test-d.ts", true],
    ["src/testing/index.ts", false],
    ["src/contest.ts", false],
    ["src/router/linear-router/router.ts", false],
  ])("reads %s as a test file: %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected)
  })
})

describe("wilsonInterval", () => {
  it("keeps an interval around a share at either end of the scale", () => {
    expect(wilsonInterval(0, 75).low).toBeCloseTo(0, 10)
    expect(wilsonInterval(0, 75).high).toBeCloseTo(0.0487, 4)
    expect(wilsonInterval(75, 75).high).toBeCloseTo(1, 10)
    expect(wilsonInterval(75, 75).low).toBeCloseTo(0.9513, 4)
  })

  it("is about eleven points either side of an even split", () => {
    const { low, high } = wilsonInterval(37, 74)
    expect(low).toBeCloseTo(0.3889, 4)
    expect(high).toBeCloseTo(0.6111, 4)
  })
})

describe("stratifiedShare", () => {
  it("weights each repository by its population", () => {
    const { share } = stratifiedShare([
      { population: 300, n: 10, hits: 10 },
      { population: 100, n: 10, hits: 0 },
    ])
    expect(share).toBeCloseTo(0.75, 10)
  })

  it("has no margin when every stratum was sampled whole", () => {
    const { margin } = stratifiedShare([
      { population: 10, n: 10, hits: 5 },
      { population: 20, n: 20, hits: 4 },
    ])
    expect(margin).toBe(0)
  })

  it("narrows as the sample takes more of a finite population", () => {
    const margin = (population) => stratifiedShare([{ population, n: 75, hits: 37 }]).margin
    expect(margin(100)).toBeLessThan(margin(3000))
    expect(margin(3000)).toBeCloseTo(0.1117, 3)
  })
})

describe("renderShares", () => {
  it.each([
    ["a category it does not define", { category: "unknown" }, /does not define: unknown/],
    ["an expected outcome it does not know", { expected: "resolved" }, /no expected outcome/],
    ["a sample without an expected outcome", { expected: null }, /no expected outcome/],
    ["a repository without a baseline", { repo: "b" }, /no baseline for: b/],
  ])("refuses %s", (_case, overrides, message) => {
    expect(() => renderShares(census([sample(overrides)]))).toThrow(message)
  })

  it("counts the gap, its edges, and what needs types, per repository and weighted by no-match", () => {
    const shares = renderShares(
      census(
        [
          sample({ repo: "a" }),
          sample({ repo: "a", expected: "edge" }),
          sample({ repo: "a", category: "typed" }),
          sample({ repo: "a", category: "typed", expected: "edge" }),
          sample({ repo: "b", expected: "local-scope" }),
          sample({ repo: "b", category: "typed", test: true }),
        ],
        [repo("a", 300), repo("b", 100)],
      ),
    )

    expect(rowOf(shares, "`rule`")).toEqual(["no", "2", "1", "3 |"])
    expect(rowOf(shares, "Resolver gap: a rule without types settles it")).toEqual([
      expect.stringMatching(/^50% /),
      expect.stringMatching(/^50% /),
      "50.0% ± 40.4% |",
    ])
    expect(rowOf(shares, "…and the rule yields a call edge")?.[0]).toMatch(/^25% /)
    expect(rowOf(shares, "…and types yield a call edge")?.[2]).toMatch(/^18\.8% /)
    expect(rowOf(shares, "Test files")).toEqual(["1", "0 (0%)", "1 (100%) |"])
    expect(rowOf(shares, "Other files")).toEqual(["5", "3 (60%)", "2 (40%) |"])
  })
})

describe("renderCheck", () => {
  it("files each sampled call by what the resolver makes of it now, and counts the ones settled as expected", () => {
    const resolved = sample({ line: 1, expected: "edge" })
    const moved = sample({ line: 2, expected: "external" })
    const bucketed = sample({ line: 3, expected: "external" })
    const untyped = sample({ line: 4, category: "typed", expected: "untyped" })
    const current = new Map([
      [
        "a",
        new Map([
          [callSiteKey(resolved), { resolved: "ts:src/b.ts#g", bucket: null }],
          [callSiteKey(bucketed), { resolved: null, bucket: "external" }],
          [callSiteKey(untyped), { resolved: null, bucket: "no-match" }],
        ]),
      ],
    ])

    const table = renderCheck(census([resolved, moved, bucketed, untyped]), current)

    expect(rowOf(table, "`rule`")).toEqual(["no", "0", "1", "0", "1", "0", "0", "1", "2 / 3 |"])
    expect(rowOf(table, "`typed`")).toEqual(["yes", "1", "0", "0", "0", "0", "0", "0", "1 / 1 |"])
  })
})
