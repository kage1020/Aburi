import type { DiffResult, IR } from "@aburi/types"
import Ajv2020, { type SchemaObject } from "ajv/dist/2020.js"
import { describe, expect, it } from "vitest"
import diffSchema from "../../../schema/aburi.diff.v1.json" with { type: "json" }
import { buildDiff } from "../src/diff"
import { fp, makeIR, makeSymbol } from "./fixtures"

/**
 * SV22 (docs/design/slice-view.md §13.6) + §11.3 — verify that the diff schema
 * addition (`slices[]`) is fully honoured at runtime, both by valid outputs
 * and by rejecting malformed shapes. Type-level assertions in
 * `packages/types/test/exports.test.ts` prove the compile-time contract; this
 * suite proves the runtime contract via Ajv, matching the strict-mode
 * validation `@aburi/config` already applies to its own schema.
 */

const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  allErrors: true,
  allowUnionTypes: false,
})
const validate = ajv.compile<DiffResult>(diffSchema satisfies SchemaObject)

function baseIR(): IR {
  return makeIR({
    symbols: [
      makeSymbol({ id: "ts:src/a.ts#A", name: "A" }),
      makeSymbol({ id: "ts:src/b.ts#B", name: "B" }),
    ],
  })
}

function headIR(): IR {
  return makeIR({
    symbols: [
      makeSymbol({ id: "ts:src/a.ts#A", name: "A", fingerprint: fp("changed-a") }),
      makeSymbol({ id: "ts:src/b.ts#B", name: "B", fingerprint: fp("changed-b") }),
      makeSymbol({ id: "ts:src/c.ts#C", name: "C" }),
    ],
  })
}

describe("aburi.diff.v1.json — runtime schema validation (SV22)", () => {
  it("validates a `buildDiff` output containing a non-empty slices[]", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "base", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
      head: { ref: "head", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
    })
    const ok = validate(diff)
    if (!ok) {
      throw new Error(`schema validation failed: ${JSON.stringify(validate.errors, null, 2)}`)
    }
    expect(ok).toBe(true)
  })

  it("validates a `buildDiff` output whose slices[] is empty (zero-Node case, §9.4)", () => {
    const ir = makeIR({ symbols: [makeSymbol({ id: "ts:src/x.ts#X", name: "X" })] })
    const diff = buildDiff({
      baseIR: ir,
      headIR: ir,
      base: { ref: "b", irSchema: ir.$schema },
      head: { ref: "h", irSchema: ir.$schema },
    })
    expect(diff.slices).toEqual([])
    expect(validate(diff)).toBe(true)
  })

  it("rejects a slices[] entry that omits the required `slice:` prefix", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "b", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
    })
    const malformed = {
      ...diff,
      slices: [{ id: "ts:src/a.ts#A", members: ["ts:src/a.ts#A"] }],
    }
    expect(validate(malformed)).toBe(false)
    expect(
      validate.errors?.some((e) => e.instancePath.includes("/slices/") && e.keyword === "pattern"),
    ).toBe(true)
  })

  it("rejects a SliceRecord with empty members[]", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "b", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
    })
    const malformed = {
      ...diff,
      slices: [{ id: "slice:ts:src/a.ts#A", members: [] as string[] }],
    }
    expect(validate(malformed)).toBe(false)
    expect(
      validate.errors?.some((e) => e.instancePath.includes("/slices/") && e.keyword === "minItems"),
    ).toBe(true)
  })

  it("rejects a SliceRecord carrying an undeclared property (additionalProperties: false)", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "b", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
    })
    const malformed = {
      ...diff,
      slices: [
        {
          id: "slice:ts:src/a.ts#A",
          members: ["ts:src/a.ts#A"],
          confidence: "high", // §14.12 explicitly forbids extra fields on SliceRecord
        },
      ],
    }
    expect(validate(malformed)).toBe(false)
    expect(validate.errors?.some((e) => e.keyword === "additionalProperties")).toBe(true)
  })

  it("rejects a SliceRecord.members[] that contains duplicates", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "b", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
    })
    const malformed = {
      ...diff,
      slices: [
        {
          id: "slice:ts:src/a.ts#A",
          members: ["ts:src/a.ts#A", "ts:src/a.ts#A"],
        },
      ],
    }
    expect(validate(malformed)).toBe(false)
    expect(validate.errors?.some((e) => e.keyword === "uniqueItems")).toBe(true)
  })

  it("rejects a DiffResult that omits the required `slices` field", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "b", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
    })
    const { slices: _slices, ...malformed } = diff
    expect(validate(malformed)).toBe(false)
    expect(
      validate.errors?.some(
        (e) => e.keyword === "required" && e.params?.missingProperty === "slices",
      ),
    ).toBe(true)
  })
})
