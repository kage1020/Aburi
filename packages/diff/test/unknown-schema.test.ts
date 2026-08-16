import type { DiffResult, IR, SkippedFile } from "@aburi/types"
import Ajv2020, { type SchemaObject } from "ajv/dist/2020.js"
import { describe, expect, it } from "vitest"
import diffSchema from "../../../schema/aburi.diff.v1.json" with { type: "json" }
import irSchema from "../../../schema/aburi.ir.v1.json" with { type: "json" }
import { buildDiff } from "../src/diff"
import { makeIR, makeSymbol } from "./fixtures"

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

describe("the two schemas agree on what a skip reason is", () => {
  it("enumerates the same values in both files", () => {
    // The reason is spelled independently in `SkippedFile.reason` (IR) and
    // `SymbolUnknown.reason` (diff), and the only compile-time link between them fires when
    // the *IR* side grows. A value added to the diff schema alone leaves an unconstructible
    // arm and a validator that accepts something nothing produces.
    const ofIR = irSchema.$defs.SkippedFile.properties.reason.enum
    const ofDiff = diffSchema.$defs.SymbolUnknown.properties.reason.enum
    expect([...ofDiff].sort()).toEqual([...ofIR].sort())
  })
})
