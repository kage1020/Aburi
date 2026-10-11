import irSchema from "@aburi/schema/aburi.ir.v1.json" with { type: "json" }
import { component, dependency, fp, makeIR, makeSymbol } from "@aburi/test-support"
import type { DiffResult, SkipReason } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffSchemaViolations } from "./diff-schema"
import { diffOf, diffSymbols, soleChange, withSkipped } from "./helpers"

const changing = makeSymbol({ id: "ts:src/a.ts#A", name: "A" })
const gone = makeSymbol({ id: "ts:src/gone.ts#foo", name: "foo" })
const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })

/** A changed Symbol, a Symbol and an edge into a file head lost, and a file neither side read. */
function lossyDiff(reason: SkipReason = "parse-failed"): DiffResult {
  return diffOf(
    withSkipped(
      makeIR({
        symbols: [changing, gone, kept],
        dependencies: [dependency({ from: gone.id, to: kept.id, via: "call" })],
      }),
      [{ path: "vendor/huge.ts", reason }],
    ),
    withSkipped(makeIR({ symbols: [{ ...changing, fingerprint: fp("x") }, kept] }), [
      { path: "src/gone.ts", reason },
      { path: "vendor/huge.ts", reason },
    ]),
  )
}

describe("a diff buildDiff writes validates against aburi.diff.v1", () => {
  it("with changed and unknown Symbols, an unknown edge, a file neither side read, and slices", () => {
    const diff = lossyDiff()
    expect(diff.summary).toMatchObject({ changed: 1, unknown: 1, depsUnknown: 1 })
    expect(diff.notCompared).toHaveLength(1)
    expect(diff.slices).not.toEqual([])
    expect(diffSchemaViolations(diff)).toEqual([])
  })

  it.each(
    irSchema.$defs.SkippedFile.properties.reason.enum,
  )("with every skip reason the IR can carry: %s", (reason) => {
    expect(diffSchemaViolations(lossyDiff(reason as SkipReason))).toEqual([])
  })

  it("with no Slice Node, and so an empty slices[]", () => {
    const diff = diffSymbols([kept], [kept])
    expect(diff.slices).toEqual([])
    expect(diffSchemaViolations(diff)).toEqual([])
  })

  it("with a changed Component whose three delta booleans are all false", () => {
    const diff = diffOf(
      makeIR({ components: [component({ id: "billing", name: "Billing" })] }),
      makeIR({ components: [component({ id: "billing", name: "Billing & Invoicing" })] }),
    )
    expect(diff.components.changed[0]?.delta).toEqual({
      rootsChanged: false,
      publicApiChanged: false,
      frameworksChanged: false,
    })
    expect(diffSchemaViolations(diff)).toEqual([])
  })

  it("with a Symbol whose only change is its confidence", () => {
    const diff = diffSymbols([kept], [{ ...kept, confidence: "low" }])
    expect(soleChange(diff.symbols, "changed").delta.confidenceChanged).toBe(true)
    expect(diffSchemaViolations(diff)).toEqual([])
  })

  it("with an unknown Symbol naming the path a renamed file was skipped under", () => {
    const diff = diffOf(
      makeIR({ symbols: [gone, kept] }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/renamed.ts", reason: "over-size" }]),
      { gitRenames: new Map([["src/gone.ts", "src/renamed.ts"]]) },
    )
    expect(soleChange(diff.symbols, "unknown").lostPath).toBe("src/renamed.ts")
    expect(diffSchemaViolations(diff)).toEqual([])
  })

  it("with a file neither side read under its renamed path, carrying the base's path", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "vendor/old.ts", reason: "over-size" }]),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "vendor/new.ts", reason: "over-size" }]),
      { gitRenames: new Map([["vendor/old.ts", "vendor/new.ts"]]) },
    )
    expect(diff.notCompared).toStrictEqual([
      {
        path: "vendor/new.ts",
        basePath: "vendor/old.ts",
        baseReason: "over-size",
        headReason: "over-size",
      },
    ])
    expect(diffSchemaViolations(diff)).toEqual([])
  })
})

describe("a diff written before a field existed still validates", () => {
  it("without confidenceChanged on a delta", () => {
    const diff = diffSymbols([kept], [{ ...kept, confidence: "low" }])
    const change = soleChange(diff.symbols, "changed")
    const { confidenceChanged: _, ...delta } = change.delta
    expect(diffSchemaViolations({ ...diff, symbols: [{ ...change, delta }] })).toEqual([])
  })

  it("without dependencies.unknown or summary.depsUnknown", () => {
    const diff = lossyDiff()
    const { unknown: _unknown, ...dependencies } = diff.dependencies
    const { depsUnknown: _depsUnknown, ...summary } = diff.summary
    expect(diffSchemaViolations({ ...diff, dependencies, summary })).toEqual([])
  })

  it("without notCompared", () => {
    const { notCompared: _, ...older } = lossyDiff()
    expect(diffSchemaViolations(older)).toEqual([])
  })
})

describe("the schema refuses a malformed diff", () => {
  const unknownEdge = (diff: DiffResult) => {
    const [edge] = diff.dependencies.unknown ?? []
    if (edge === undefined) throw new Error("the fixture lost no edge")
    return edge
  }

  it.each<[string, (diff: DiffResult) => unknown, string]>([
    [
      "a Slice id without the `slice:` prefix",
      (diff) => ({ ...diff, slices: [{ id: "ts:src/a.ts#A", members: ["ts:src/a.ts#A"] }] }),
      "/slices/0/id pattern",
    ],
    [
      "a Slice with no members",
      (diff) => ({ ...diff, slices: [{ id: "slice:ts:src/a.ts#A", members: [] }] }),
      "/slices/0/members minItems",
    ],
    [
      "a Slice member listed twice",
      (diff) => ({
        ...diff,
        slices: [{ id: "slice:ts:src/a.ts#A", members: ["ts:src/a.ts#A", "ts:src/a.ts#A"] }],
      }),
      "/slices/0/members uniqueItems",
    ],
    [
      "a Slice carrying an undeclared property",
      (diff) => ({
        ...diff,
        slices: [{ id: "slice:ts:src/a.ts#A", members: ["ts:src/a.ts#A"], confidence: "high" }],
      }),
      "/slices/0 additionalProperties",
    ],
    ["a diff without slices", ({ slices: _, ...rest }) => rest, "/ required"],
    [
      "an unknown Symbol with an empty lostPath",
      (diff) => ({ ...diff, symbols: [{ ...soleChange(diff.symbols, "unknown"), lostPath: "" }] }),
      "/symbols/0/lostPath minLength",
    ],
    [
      "an unknown Symbol that does not say which side lost the file",
      (diff) => {
        const { absentFrom: _, ...entry } = soleChange(diff.symbols, "unknown")
        return { ...diff, symbols: [entry] }
      },
      "/symbols/0 oneOf",
    ],
    [
      "an unknown edge with no lost files",
      (diff) => ({
        ...diff,
        dependencies: { ...diff.dependencies, unknown: [{ ...unknownEdge(diff), lostFiles: [] }] },
      }),
      "/dependencies/unknown/0/lostFiles minItems",
    ],
    [
      "a lost file carrying an undeclared property",
      (diff) => ({
        ...diff,
        dependencies: {
          ...diff.dependencies,
          unknown: [
            {
              ...unknownEdge(diff),
              lostFiles: [{ path: "src/gone.ts", reason: "over-size", detail: "big" }],
            },
          ],
        },
      }),
      "/dependencies/unknown/0/lostFiles/0 additionalProperties",
    ],
    [
      "a notCompared entry with only one side's reason",
      (diff) => ({ ...diff, notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size" }] }),
      "/notCompared/0 required",
    ],
    [
      "a notCompared reason the IR could never have written",
      (diff) => ({
        ...diff,
        notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size", headReason: "gave-up" }],
      }),
      "/notCompared/0/headReason enum",
    ],
    [
      "a notCompared entry carrying an undeclared property",
      (diff) => ({
        ...diff,
        notCompared: [
          {
            path: "vendor/huge.ts",
            baseReason: "over-size",
            headReason: "parse-timeout",
            detail: "3.2 MB",
          },
        ],
      }),
      "/notCompared/0 additionalProperties",
    ],
  ])("refuses %s", (_, malform, violation) => {
    expect(diffSchemaViolations(malform(lossyDiff()))).toContain(violation)
  })
})
