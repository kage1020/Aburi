import type { DiffResult, IR, SkippedFile } from "@aburi/types"
import Ajv2020, { type SchemaObject } from "ajv/dist/2020.js"
import { describe, expect, it } from "vitest"
import diffSchema from "../../../schema/aburi.diff.v1.json" with { type: "json" }
import irSchema from "../../../schema/aburi.ir.v1.json" with { type: "json" }
import { buildDiff } from "../src/diff"
import { dependency, makeIR, makeSymbol } from "./fixtures"

/**
 * Instance conformance for the diff shape this change added.
 *
 * `codegen-drift` proves the generated types match the schemas, and TypeScript accepts
 * excess properties structurally — so a value that violates `additionalProperties: false` or
 * omits a `required` key type-checks, passes every unit test, and is rejected by the first
 * third-party validator that reads the artifact. Nothing validated a `SymbolUnknown` entry
 * against the published schema until here.
 *
 * `summary.unknown` matters for the same reason without being new: `buildDiff` now writes it
 * on every diff, so the shape of every `diff.json` changed.
 *
 * The IR side is validated in `@aburi/e2e-integration`, against a document a real scan
 * produced: this package's fixtures carry placeholder fingerprints the IR schema refuses,
 * which is fine for a diff and useless for conformance.
 */

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
    // The counterpart of the Markdown side's "omits the group for a diff that predates the
    // field". The two were asymmetric: nothing here showed that such a document still reads.
    const diff = edgeDiff()
    const { unknown: _dropped, ...dependencies } = diff.dependencies
    const { depsUnknown: _counter, ...summary } = diff.summary
    const older = { ...diff, dependencies, summary }
    expect(validateDiff(older), report(validateDiff.errors)).toBe(true)
  })

  it("refuses an entry whose lostFiles is empty", () => {
    // `minItems: 1` is the schema saying what the classification means: an entry exists
    // because a file went missing, so one with no file is a claim with nothing behind it.
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

  it("validates a diff that predates the field, with no key at all", () => {
    const { notCompared: _dropped, ...older } = symmetricDiff()
    expect(validateDiff(older), report(validateDiff.errors)).toBe(true)
  })

  it("refuses an entry that reports only one side's reason", () => {
    // The pair is the point: a file that timed out on one revision and was over the cap on the
    // other needs two different actions, and half the answer sends the reader to the wrong one.
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
    // Spelled independently in `SkippedFile.reason` (IR) and `SkipReason` (diff), and the only
    // compile-time link between them fires when the *IR* side grows. A value added to the diff
    // schema alone leaves an unconstructible arm and a validator that accepts something nothing
    // produces. One comparison rather than one per use site: the diff schema hoisted the enum
    // into a single `$def` that both `SymbolUnknown.reason` and `SkippedFile.reason` point at.
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
