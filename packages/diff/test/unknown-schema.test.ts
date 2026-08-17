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

describe("the schemas agree on what a skip reason is", () => {
  it("enumerates the same values everywhere it is spelled", () => {
    // The reason is spelled independently in `SkippedFile.reason` (IR), `SymbolUnknown.reason`
    // and `SkippedFile.reason` (diff), and the only compile-time link between them fires when
    // the *IR* side grows. A value added to one file alone leaves an unconstructible arm and a
    // validator that accepts something nothing produces.
    const ofIR = [...irSchema.$defs.SkippedFile.properties.reason.enum].sort()
    for (const [where, values] of [
      ["SymbolUnknown.reason", diffSchema.$defs.SymbolUnknown.properties.reason.enum],
      ["SkippedFile.reason", diffSchema.$defs.SkippedFile.properties.reason.enum],
    ] as const) {
      expect([...values].sort(), where).toEqual(ofIR)
    }
  })
})
