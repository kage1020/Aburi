import diffSchema from "@aburi/schema/aburi.diff.v1.json" with { type: "json" }
import irSchema from "@aburi/schema/aburi.ir.v1.json" with { type: "json" }
import { dependency, makeIR, makeSymbol } from "@aburi/test-support"
import type { DiffResult, IR, SkippedFile } from "@aburi/types"
import Ajv2020, { type SchemaObject } from "ajv/dist/2020.js"
import { describe, expect, it } from "vitest"
import { buildDiff } from "../src/diff"

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true })
const validateDiff = ajv.compile<DiffResult>(diffSchema satisfies SchemaObject)

function withSkipped(ir: IR, skipped: readonly SkippedFile[], totalFiles: number): IR {
  return {
    ...ir,
    stats: {
      ...ir.stats,
      totalFiles,
      parsedFiles: totalFiles - skipped.length,
      skippedFiles: [...skipped],
    },
  }
}

function report(errors: unknown): string {
  return JSON.stringify(errors, null, 2)
}

const gone = makeSymbol({ id: "ts:src/gone.ts#foo", name: "foo" })
const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })

describe("aburi.diff.v1.json — SymbolUnknown instances", () => {
  const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

  it("validates a diff carrying unknown entries and the counter", () => {
    const diff = buildDiff({
      baseIR: makeIR({ symbols: [gone, kept] }),
      headIR: withSkipped(
        makeIR({ symbols: [kept] }),
        [{ path: "src/gone.ts", reason: "parse-timeout" }],
        2,
      ),
      base: IR_REF,
      head: IR_REF,
    })
    expect(diff.summary.unknown).toBe(1)
    expect(validateDiff(diff), report(validateDiff.errors)).toBe(true)
  })

  it("validates an unknown entry naming the path a renamed file was skipped under", () => {
    const diff = buildDiff({
      baseIR: makeIR({ symbols: [gone, kept] }),
      headIR: withSkipped(
        makeIR({ symbols: [kept] }),
        [{ path: "src/renamed.ts", reason: "over-size" }],
        2,
      ),
      base: IR_REF,
      head: IR_REF,
      gitRenames: new Map([["src/gone.ts", "src/renamed.ts"]]),
    })
    const [entry] = diff.symbols
    expect(entry?.status === "unknown" ? entry.lostPath : null).toBe("src/renamed.ts")
    expect(validateDiff(diff), report(validateDiff.errors)).toBe(true)
  })

  it("refuses an empty lostPath", () => {
    const diff = buildDiff({
      baseIR: makeIR({ symbols: [kept] }),
      headIR: makeIR({ symbols: [kept] }),
      base: IR_REF,
      head: IR_REF,
    })
    const broken = {
      ...diff,
      symbols: [
        { status: "unknown", symbol: gone, absentFrom: "head", reason: "over-size", lostPath: "" },
      ],
    }
    expect(validateDiff(broken)).toBe(false)
  })

  it("validates a diff with no unknown entries, where the counter is zero", () => {
    const diff = buildDiff({
      baseIR: makeIR({ symbols: [kept] }),
      headIR: makeIR({ symbols: [kept, gone] }),
      base: IR_REF,
      head: IR_REF,
    })
    expect(validateDiff(diff), report(validateDiff.errors)).toBe(true)
  })

  it("refuses an unknown entry missing the side that lost the file", () => {
    const diff = buildDiff({
      baseIR: makeIR({ symbols: [kept] }),
      headIR: makeIR({ symbols: [kept] }),
      base: IR_REF,
      head: IR_REF,
    })
    const broken = {
      ...diff,
      symbols: [{ status: "unknown", symbol: gone, reason: "parse-failed" }],
    }
    expect(validateDiff(broken)).toBe(false)
  })
})

describe("aburi.diff.v1.json — DependencyUnknown instances", () => {
  const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

  function edgeDiff(): DiffResult {
    return buildDiff({
      baseIR: makeIR({
        symbols: [gone, kept],
        dependencies: [
          dependency({ from: "ts:src/gone.ts#foo", to: "ts:src/kept.ts#kept", via: "call" }),
        ],
      }),
      headIR: withSkipped(
        makeIR({ symbols: [kept] }),
        [{ path: "src/gone.ts", reason: "extraction-failed" }],
        2,
      ),
      base: IR_REF,
      head: IR_REF,
    })
  }

  it("validates a diff carrying an unknown edge and the counter", () => {
    const diff = edgeDiff()
    expect(diff.summary.depsUnknown).toBe(1)
    expect(validateDiff(diff), report(validateDiff.errors)).toBe(true)
  })

  it("validates a diff that predates the field, with no unknown key at all", () => {
    const diff = edgeDiff()
    const { unknown: _dropped, ...dependencies } = diff.dependencies
    const { depsUnknown: _counter, ...summary } = diff.summary
    const older = { ...diff, dependencies, summary }
    expect(validateDiff(older), report(validateDiff.errors)).toBe(true)
  })

  it("refuses an entry whose lostFiles is empty", () => {
    const diff = edgeDiff()
    const first = diff.dependencies.unknown?.[0]
    if (first === undefined) throw new Error("fixture produced no unknown edge")
    const broken = {
      ...diff,
      dependencies: { ...diff.dependencies, unknown: [{ ...first, lostFiles: [] }] },
    }
    expect(validateDiff(broken)).toBe(false)
  })

  it("refuses a lostFiles entry with a field the schema does not know", () => {
    const diff = edgeDiff()
    const first = diff.dependencies.unknown?.[0]
    if (first === undefined) throw new Error("fixture produced no unknown edge")
    const broken = {
      ...diff,
      dependencies: {
        ...diff.dependencies,
        unknown: [
          { ...first, lostFiles: [{ path: "src/gone.ts", reason: "over-size", detail: "big" }] },
        ],
      },
    }
    expect(validateDiff(broken)).toBe(false)
  })
})

describe("aburi.diff.v1.json — notCompared instances", () => {
  const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

  function symmetricDiff(): DiffResult {
    const skipped: SkippedFile[] = [{ path: "vendor/huge.ts", reason: "over-size" }]
    return buildDiff({
      baseIR: withSkipped(makeIR({ symbols: [kept] }), skipped, 2),
      headIR: withSkipped(
        makeIR({ symbols: [kept] }),
        [{ path: "vendor/huge.ts", reason: "parse-timeout" }],
        2,
      ),
      base: IR_REF,
      head: IR_REF,
    })
  }

  it("validates a diff naming a file neither scan read", () => {
    const diff = symmetricDiff()
    expect(diff.notCompared).toHaveLength(1)
    expect(validateDiff(diff), report(validateDiff.errors)).toBe(true)
  })

  it("validates an entry for a renamed file, carrying the base's path", () => {
    const diff = buildDiff({
      baseIR: withSkipped(
        makeIR({ symbols: [kept] }),
        [{ path: "vendor/old.ts", reason: "over-size" }],
        2,
      ),
      headIR: withSkipped(
        makeIR({ symbols: [kept] }),
        [{ path: "vendor/new.ts", reason: "over-size" }],
        2,
      ),
      base: IR_REF,
      head: IR_REF,
      gitRenames: new Map([["vendor/old.ts", "vendor/new.ts"]]),
    })
    expect(diff.notCompared).toStrictEqual([
      {
        path: "vendor/new.ts",
        basePath: "vendor/old.ts",
        baseReason: "over-size",
        headReason: "over-size",
      },
    ])
    expect(validateDiff(diff), report(validateDiff.errors)).toBe(true)
  })

  it("validates a diff that predates the field, with no key at all", () => {
    const { notCompared: _dropped, ...older } = symmetricDiff()
    expect(validateDiff(older), report(validateDiff.errors)).toBe(true)
  })

  it("refuses an entry that reports only one side's reason", () => {
    const diff = symmetricDiff()
    const broken = {
      ...diff,
      notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size" }],
    }
    expect(validateDiff(broken)).toBe(false)
  })

  it("refuses a reason the IR could never have written", () => {
    const diff = symmetricDiff()
    const broken = {
      ...diff,
      notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size", headReason: "gave-up" }],
    }
    expect(validateDiff(broken)).toBe(false)
  })

  it("refuses an entry carrying a field the schema does not know", () => {
    const diff = symmetricDiff()
    const broken = {
      ...diff,
      notCompared: [
        {
          path: "vendor/huge.ts",
          baseReason: "over-size",
          headReason: "parse-timeout",
          detail: "3.2 MB",
        },
      ],
    }
    expect(validateDiff(broken)).toBe(false)
  })
})

describe("the schemas agree on what a skip reason is", () => {
  it("enumerates the same values as the IR", () => {
    const ofIR = [...irSchema.$defs.SkippedFile.properties.reason.enum].sort()
    expect([...diffSchema.$defs.SkipReason.enum].sort()).toEqual(ofIR)
  })

  it("points every one of the diff's own uses at that one definition", () => {
    const ref = { $ref: "#/$defs/SkipReason" }
    expect(diffSchema.$defs.SymbolUnknown.properties.reason).toEqual(ref)
    expect(diffSchema.$defs.SkippedFile.properties.reason).toEqual(ref)
    expect(diffSchema.$defs.NotComparedFile.properties.baseReason).toEqual(ref)
    expect(diffSchema.$defs.NotComparedFile.properties.headReason).toEqual(ref)
  })
})
