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
    "components",
    "symbols",
    "dependencies",
    "workspace",
    "stats",
    "generator",
  ])("names the enclosing record and the missing field for %s", (key) => {
    const violations = shapeViolations(without(key))
    expect(violations).toHaveLength(1)
    expect(violations[0]?.subject).toBe("document")
    expect(violations[0]?.message).toContain(`"${key}" is absent`)
  })

  it.each([
    ["symbols", {}, "not an array"],
    ["components", "nope", "not an array"],
    ["dependencies", 7, "not an array"],
    ["workspace", [], "not an object"],
    ["stats", null, "not an object"],
  ])("reports %s when it is present but the wrong type", (key, value, expected) => {
    const violations = shapeViolations(withField(key, value))
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain(expected)
  })

  it("descends into every nested record the branded type promises", () => {
    const subjects = shapeViolations(
      withField("workspace", { managers: [{}], languages: ["ts"] }),
    ).map((v) => v.subject)
    expect(subjects).toContain("workspace")
    expect(subjects).toContain("workspace.managers[0]")
  })

  it("names the record and the field for a Symbol missing everything", () => {
    const violations = shapeViolations(withField("symbols", [{}]))
    for (const violation of violations) {
      expect(violation.subject).toBe("symbols[0]")
    }
    const messages = violations.map((v) => v.message)
    // `fingerprint` and `visibility` are read by `@aburi/diff` rather than by any invariant.
    // They are here because `readIR` brands its result `IR`, and that is what the brand says.
    for (const field of [
      "id",
      "name",
      "kind",
      "source",
      "effects",
      "calls",
      "fingerprint",
      "visibility",
    ]) {
      expect(
        messages.some((m) => m.includes(`"${field}"`)),
        field,
      ).toBe(true)
    }
  })

  it.each([
    ["components", [{ id: "a" }], "components[0]"],
    ["dependencies", [{ from: "a" }], "dependencies[0]"],
  ])("names the record for a malformed %s entry", (key, value, subject) => {
    const violations = shapeViolations(withField(key, value))
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every((v) => v.subject === subject)).toBe(true)
  })

  it("names the record for a malformed effect and call inside a Symbol", () => {
    const symbol = makeSymbol("ts:src/a.ts#foo") as unknown as Record<string, unknown>
    symbol.effects = [{ id: "db.write" }]
    symbol.calls = [{ line: 1 }]
    const subjects = shapeViolations(withField("symbols", [symbol])).map((v) => v.subject)
    expect(subjects).toContain("symbols[0].effects[0]")
    expect(subjects).toContain("symbols[0].calls[0]")
  })

  it("names the element, not the array, when a string array holds a non-string", () => {
    // `components[].roots` and `workspace.managers[].roots` reach `posixWorkspaceRelative-
    // Violation`, which calls `.includes` on each entry; `publicApi` reaches `.normalize`.
    const violations = shapeViolations(
      withField("components", [{ ...makeComponent("a"), roots: [7] }]),
    )
    expect(violations.map((v) => v.subject)).toContain("components[0].roots[0]")
  })

  it("reports NaN and Infinity as themselves rather than as numbers", () => {
    const symbol = makeSymbol("ts:src/a.ts#foo") as unknown as Record<string, unknown>
    symbol.calls = [{ target: "t", line: Number.NaN, resolved: null }]
    const messages = shapeViolations(withField("symbols", [symbol])).map((v) => v.message)
    expect(messages.some((m) => m.includes("is NaN, not a finite number"))).toBe(true)
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
