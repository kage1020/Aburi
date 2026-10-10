import { component, fp, makeIR, makeSymbol } from "@aburi/test-support"
import type { DiffResult, IR } from "@aburi/types"
import Ajv2020, { type ErrorObject, type SchemaObject } from "ajv/dist/2020.js"
import { describe, expect, it } from "vitest"
import diffSchema from "../../../schema/aburi.diff.v1.json" with { type: "json" }
import { buildDiff } from "../src/diff"
import { sliceRecordViolation } from "../src/slice"

const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  allErrors: true,
  allowUnionTypes: false,
})

interface AnchorKeywordValidator {
  (enabled: boolean, record: unknown): boolean
  errors?: Partial<ErrorObject>[]
}

const validateAnchorDerived: AnchorKeywordValidator = (enabled, record) => {
  if (!enabled) return true
  const violation = sliceRecordViolation(record)
  if (violation === null) return true
  validateAnchorDerived.errors = [
    { keyword: "sliceAnchorDerived", message: violation.message, params: { kind: violation.kind } },
  ]
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

const schemaWithAnchorInvariant = {
  ...diffSchema,
  // Distinct base URI so Ajv does not see two schemas registered under one $id.
  $id: "https://aburi.kage1020.com/schema/aburi.diff.v1.with-anchor-invariant.json",
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
      base: { ref: "base", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "head", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
    })
    const ok = validate(diff)
    if (!ok) {
      throw new Error(`schema validation failed: ${JSON.stringify(validate.errors, null, 2)}`)
    }
    expect(ok).toBe(true)
  })

  it("validates a `buildDiff` output whose slices[] is empty (zero-Node case)", () => {
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

  it("validates a changed component whose three delta booleans are all false", () => {
    const before = component({ id: "billing", name: "Billing" })
    const after = component({ id: "billing", name: "Billing & Invoicing" })
    const diff = buildDiff({
      baseIR: makeIR({ components: [before], symbols: [] }),
      headIR: makeIR({ components: [after], symbols: [] }),
      base: { ref: "b", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
    })
    expect(diff.summary.componentsChanged).toBe(1)
    expect(diff.components.changed[0]?.delta).toEqual({
      rootsChanged: false,
      publicApiChanged: false,
      frameworksChanged: false,
    })
    const ok = validate(diff)
    if (!ok) {
      throw new Error(`schema validation failed: ${JSON.stringify(validate.errors, null, 2)}`)
    }
    expect(ok).toBe(true)
  })

  it("validates a Symbol whose only change is its confidence, and one written before the flag", () => {
    const sure = makeSymbol({ id: "ts:src/x.ts#X", name: "X", confidence: "high" })
    const diff = buildDiff({
      baseIR: makeIR({ symbols: [sure] }),
      headIR: makeIR({ symbols: [{ ...sure, confidence: "low" }] }),
      base: { ref: "b", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
    })
    const [change] = diff.symbols
    if (change?.status !== "changed") throw new Error("expected a changed entry")
    expect(change.delta.confidenceChanged).toBe(true)
    expect(validate(diff)).toBe(true)

    const { confidenceChanged: _, ...older } = change.delta
    expect(validate({ ...diff, symbols: [{ ...change, delta: older }] })).toBe(true)
  })

  it("rejects a slices[] entry that omits the required `slice:` prefix", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "b", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
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
      base: { ref: "b", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
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
      base: { ref: "b", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
    })
    const malformed = {
      ...diff,
      slices: [
        {
          id: "slice:ts:src/a.ts#A",
          members: ["ts:src/a.ts#A"],
          confidence: "high",
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
      base: { ref: "b", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
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
      base: { ref: "b", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
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
  function diffWithSlices(slices: Array<{ id: string; members: string[] }>): unknown {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "b", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "h", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
    })
    return { ...diff, slices }
  }

  it("accepts a real `buildDiff` output whose slices[] the pass derived itself", () => {
    const diff = buildDiff({
      baseIR: baseIR(),
      headIR: headIR(),
      base: { ref: "base", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
      head: { ref: "head", irSchema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json" },
    })
    expect(diff.slices.length).toBeGreaterThan(0)
    const ok = validateWithAnchorInvariant(diff)
    if (!ok) {
      throw new Error(
        `schema validation failed: ${JSON.stringify(validateWithAnchorInvariant.errors, null, 2)}`,
      )
    }
    expect(ok).toBe(true)

    for (const slice of diff.slices) {
      expect(slice.id).toBe(`slice:${slice.members[0]}`)
      for (let i = 1; i < slice.members.length; i++) {
        expect((slice.members[i - 1] as string) < (slice.members[i] as string)).toBe(true)
      }
    }
  })

  it("rejects a correct `slice:` prefix whose id is not the anchor", () => {
    const malformed = diffWithSlices([
      { id: "slice:ts:src/b.ts#B", members: ["ts:src/a.ts#A", "ts:src/b.ts#B"] },
    ])

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

  it("points at the offending entry rather than always at slices[0]", () => {
    const malformed = diffWithSlices([
      { id: "slice:ts:src/a.ts#A", members: ["ts:src/a.ts#A"] },
      { id: "slice:ts:src/c.ts#C", members: ["ts:src/b.ts#B", "ts:src/c.ts#C"] },
      { id: "slice:ts:src/d.ts#D", members: ["ts:src/d.ts#D"] },
    ])
    expect(validateWithAnchorInvariant(malformed)).toBe(false)
    const paths = (validateWithAnchorInvariant.errors ?? [])
      .filter((e) => e.keyword === "sliceAnchorDerived")
      .map((e) => e.instancePath)
    expect(paths).toEqual(["/slices/1"])
  })

  it("reports every offending entry under allErrors, each with its own reason", () => {
    const malformed = diffWithSlices([
      { id: "slice:ts:src/a.ts#A", members: ["ts:src/a.ts#A"] },
      { id: "slice:ts:src/z.ts#Z", members: ["ts:src/b.ts#B", "ts:src/c.ts#C"] },
      { id: "slice:ts:src/e.ts#E", members: ["ts:src/f.ts#F", "ts:src/e.ts#E"] },
    ])
    expect(validateWithAnchorInvariant(malformed)).toBe(false)
    const reported = (validateWithAnchorInvariant.errors ?? [])
      .filter((e) => e.keyword === "sliceAnchorDerived")
      .map((e) => `${e.instancePath}: ${e.message}`)
    expect(reported).toHaveLength(2)
    expect(reported[0]).toMatch(/^\/slices\/1: .*not derived from the anchor/)
    expect(reported[1]).toMatch(/^\/slices\/2: .*strictly ascending/)
  })
})
