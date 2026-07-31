import type { DiffResult, IR, SliceRecord } from "@aburi/types"
import Ajv2020, { type ErrorObject, type SchemaObject } from "ajv/dist/2020.js"
import { describe, expect, it } from "vitest"
import diffSchema from "../../../schema/aburi.diff.v1.json" with { type: "json" }
import { buildDiff } from "../src/diff"
import { sliceRecordViolation } from "../src/slice"
import { fp, makeIR, makeSymbol } from "./fixtures"

/**
 * SV22 and SV24 (docs/design/slice-view.md §13.6, §13.7) + §11.3 — verify that
 * the diff schema addition (`slices[]`) is fully honoured at runtime, both by
 * valid outputs and by rejecting malformed shapes. Type-level assertions in
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

/**
 * §7.4 layer 2 — the anchor derivation and the ascending `members[]` order
 * compare one property against another, which standard JSON Schema 2020-12
 * cannot express. The keyword lives here, in the validating consumer, and NOT
 * in `schema/aburi.diff.v1.json`: that file is a frozen v1 artifact published
 * for readers outside this repository, and a non-standard keyword inside it
 * would make every strict-mode validator reject the schema itself.
 *
 * `errors` on the function is how Ajv keywords report a custom message — it is
 * read right after `validate` returns false, so the reason from
 * `sliceRecordViolation` reaches the caller instead of Ajv's generic
 * "must pass keyword validation".
 */
interface AnchorKeywordValidator {
  (enabled: boolean, record: SliceRecord): boolean
  errors?: Partial<ErrorObject>[]
}

const validateAnchorDerived: AnchorKeywordValidator = (enabled, record) => {
  if (!enabled) return true
  const violation = sliceRecordViolation(record)
  if (violation === null) return true
  validateAnchorDerived.errors = [{ keyword: "sliceAnchorDerived", message: violation, params: {} }]
  return false
}

ajv.addKeyword({
  keyword: "sliceAnchorDerived",
  type: "object",
  schemaType: "boolean",
  errors: true,
  validate: validateAnchorDerived,
})

const validate = ajv.compile<DiffResult>(diffSchema satisfies SchemaObject)

/**
 * The published schema with the derivation keyword layered on top. Built by
 * spreading rather than mutating so `schema/aburi.diff.v1.json` — and the
 * `validate` above, which every pre-existing negative test uses — stay exactly
 * as shipped.
 */
const schemaWithAnchorInvariant = {
  ...diffSchema,
  // Distinct base URI so Ajv does not see two schemas registered under one $id.
  $id: "https://aburi.dev/schema/aburi.diff.v1.with-anchor-invariant.json",
  $defs: {
    ...diffSchema.$defs,
    SliceRecord: { ...diffSchema.$defs.SliceRecord, sliceAnchorDerived: true },
  },
} satisfies SchemaObject
const validateWithAnchorInvariant = ajv.compile<DiffResult>(schemaWithAnchorInvariant)

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

describe("aburi.diff.v1.json — anchor derivation invariant (SV24)", () => {
  function diffWithSlices(slices: SliceRecord[]): unknown {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "b", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
    })
    return { ...diff, slices }
  }

  it("accepts a real `buildDiff` output whose slices[] the pass derived itself", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "base", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
      head: { ref: "head", irSchema: "https://aburi.dev/schema/aburi.ir.v1.json" },
    })
    expect(diff.slices.length).toBeGreaterThan(0)
    const ok = validateWithAnchorInvariant(diff)
    if (!ok) {
      throw new Error(
        `schema validation failed: ${JSON.stringify(validateWithAnchorInvariant.errors, null, 2)}`,
      )
    }
    expect(ok).toBe(true)
  })

  it("rejects a correct `slice:` prefix whose id is not the anchor", () => {
    const malformed = diffWithSlices([
      { id: "slice:ts:src/b.ts#B", members: ["ts:src/a.ts#A", "ts:src/b.ts#B"] },
    ])

    // The published schema alone cannot see this: the prefix matches, members
    // are unique, non-empty, and there is no extra property. Pinning that fact
    // is the point — it is exactly why the keyword exists (§11.1).
    expect(validate(malformed)).toBe(true)

    expect(validateWithAnchorInvariant(malformed)).toBe(false)
    expect(
      validateWithAnchorInvariant.errors?.some(
        (e) => e.instancePath.includes("/slices/") && e.keyword === "sliceAnchorDerived",
      ),
    ).toBe(true)
  })

  it("rejects members[] that are not in ascending order", () => {
    const malformed = diffWithSlices([
      { id: "slice:ts:src/b.ts#B", members: ["ts:src/b.ts#B", "ts:src/a.ts#A"] },
    ])
    expect(validate(malformed)).toBe(true)
    expect(validateWithAnchorInvariant(malformed)).toBe(false)
    expect(
      validateWithAnchorInvariant.errors?.some((e) => e.keyword === "sliceAnchorDerived"),
    ).toBe(true)
  })

  it("still rejects a malformed prefix, the same way the base schema does", () => {
    const malformed = diffWithSlices([{ id: "ts:src/a.ts#A", members: ["ts:src/a.ts#A"] }])
    expect(validate(malformed)).toBe(false)
    expect(validateWithAnchorInvariant(malformed)).toBe(false)
  })
})
