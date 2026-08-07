import { describe, expect, it } from "vitest"
import { assertIRIntegrity, CoreError, checkIRIntegrity } from "../src/index"
import { makeComponent, makeSymbol, minimalIR } from "./fixtures/ir"

/**
 * `checkIRIntegrity` is the only gate `readIR` applies to a Document it reads off disk, so
 * "what is wrong with this Document?" has to have an answer for every input — including one
 * that is not shaped like a Document at all. It used to dereference its way into a
 * `TypeError`, which the CLI then reported as "failed to load" with no indication of what
 * broke, which is the one thing the invariant list exists to say.
 */

/** Build a Document with one top-level key removed. */
function without(key: string): unknown {
  const ir = minimalIR() as unknown as Record<string, unknown>
  delete ir[key]
  return ir
}

/** Build a Document with one top-level key replaced. */
function withField(key: string, value: unknown): unknown {
  return { ...(minimalIR() as unknown as Record<string, unknown>), [key]: value }
}

function shapeViolations(document: unknown) {
  return checkIRIntegrity(document).filter((v) => v.invariant === 20)
}

describe("checkIRIntegrity — documents that are not shaped like a Document", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "not an IR"],
    ["a number", 42],
    ["an empty object", {}],
  ])("answers rather than throwing for %s", (_what, document) => {
    expect(() => checkIRIntegrity(document)).not.toThrow()
    expect(shapeViolations(document).length).toBeGreaterThan(0)
  })

  it.each([
    ["components", "components"],
    ["symbols", "symbols"],
    ["dependencies", "dependencies"],
    ["workspace", "workspace"],
    ["stats", "stats"],
  ])("reports the missing top-level container %s by name", (_what, key) => {
    const violations = shapeViolations(without(key))
    expect(violations).toHaveLength(1)
    expect(violations[0]?.subject).toBe(key)
  })

  it.each([
    ["symbols", {}],
    ["components", "nope"],
    ["dependencies", 7],
  ])("reports %s when it is present but not an array", (key, value) => {
    const violations = shapeViolations(withField(key, value))
    expect(violations).toHaveLength(1)
    expect(violations[0]?.subject).toBe(key)
  })

  it("reports the workspace sub-containers the invariants read", () => {
    expect(
      shapeViolations(withField("workspace", {}))
        .map((v) => v.subject)
        .sort(),
    ).toEqual(["workspace.languages", "workspace.managers"])
  })

  it("names the record and the field for a Symbol missing everything", () => {
    const violations = shapeViolations(withField("symbols", [{}]))
    expect(violations.length).toBeGreaterThan(0)
    for (const violation of violations) {
      expect(violation.subject).toBe("symbols[0]")
    }
    const fields = violations.map((v) => v.message)
    for (const field of ["id", "name", "kind", "source", "effects", "calls"]) {
      expect(
        fields.some((m) => m.includes(`"${field}"`)),
        field,
      ).toBe(true)
    }
  })

  it("names the record for a malformed component, manager and dependency", () => {
    const cases: Array<[key: string, value: unknown, subject: string]> = [
      ["components", [{ id: "a" }], "components[0]"],
      ["dependencies", [{ from: "a" }], "dependencies[0]"],
    ]
    for (const [key, value, subject] of cases) {
      const violations = shapeViolations(withField(key, value))
      expect(violations.length, subject).toBeGreaterThan(0)
      expect(
        violations.every((v) => v.subject === subject),
        subject,
      ).toBe(true)
    }
    const managers = shapeViolations(
      withField("workspace", { managers: [{}], languages: ["ts"], root: "." }),
    )
    expect(managers.every((v) => v.subject === "workspace.managers[0]")).toBe(true)
  })

  it("names the record for a malformed effect and call inside a Symbol", () => {
    const symbol = makeSymbol("ts:src/a.ts#foo") as unknown as Record<string, unknown>
    symbol.effects = [{ id: "db.write" }]
    symbol.calls = [{ line: 1 }]
    const subjects = shapeViolations(withField("symbols", [symbol])).map((v) => v.subject)
    expect(subjects).toContain("symbols[0].effects[0]")
    expect(subjects).toContain("symbols[0].calls[0]")
  })

  it("reports the shape alone, without the invariants derived from what is missing", () => {
    // Running the relational checks against fields the shape check just called absent
    // produces violations about `undefined`, which bury the one fact the reader needs.
    const violations = checkIRIntegrity(withField("symbols", [{}]))
    expect(violations.every((v) => v.invariant === 20)).toBe(true)
  })

  it("says nothing about a well-formed Document", () => {
    const ir = minimalIR()
    ir.components = [makeComponent("a")]
    ir.symbols = [makeSymbol("ts:src/a.ts#foo", { component: "a" })]
    ir.workspace.managers = [{ tool: "pnpm", roots: ["apps/a"] }]
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("assertIRIntegrity reports it as an integrity violation, not a TypeError", () => {
    let caught: unknown
    try {
      assertIRIntegrity(without("workspace"))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CoreError)
    expect((caught as CoreError).code).toBe("integrity-violation")
    expect((caught as CoreError).violations?.some((v) => v.invariant === 20)).toBe(true)
    expect((caught as CoreError).message).toContain("workspace")
  })
})
