import { component, makeIR, sig } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { assertIRIntegrity, CoreError, checkIRIntegrity } from "../src/index"
import { makeSymbol } from "./fixtures/ir"

function without(key: string): unknown {
  const ir = makeIR() as unknown as Record<string, unknown>
  delete ir[key]
  return ir
}

function withField(key: string, value: unknown): unknown {
  return { ...(makeIR() as unknown as Record<string, unknown>), [key]: value }
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
    const violations = shapeViolations(
      withField("components", [{ ...component({ id: "a", name: "a" }), roots: [7] }]),
    )
    expect(violations.map((v) => v.subject)).toContain("components[0].roots[0]")
  })

  it("checks a parameter's optional and rest markers when they are present", () => {
    const symbol = makeSymbol("ts:src/a.ts#foo", {
      signature: sig({
        inputs: [
          { name: "a", type: "string", optional: true },
          { name: "ids", type: "string[]", rest: true },
        ],
      }),
    }) as unknown as Record<string, unknown>
    expect(shapeViolations(withField("symbols", [symbol]))).toEqual([])

    symbol.signature = {
      ...sig(),
      inputs: [{ name: "a", type: "string", optional: "yes", rest: 1 }],
    }
    const violations = shapeViolations(withField("symbols", [symbol]))
    expect(violations.map((v) => [v.subject, v.message])).toEqual([
      ["symbols[0].signature.inputs[0]", '"optional" is a string, not a boolean'],
      ["symbols[0].signature.inputs[0]", '"rest" is a number, not a boolean'],
    ])
  })

  it("checks a destructuring parameter's bindings when they are present", () => {
    const symbol = makeSymbol("ts:src/a.ts#foo", {
      signature: sig({ inputs: [{ name: "{ save }", type: "Deps", bindings: ["save"] }] }),
    }) as unknown as Record<string, unknown>
    expect(shapeViolations(withField("symbols", [symbol]))).toEqual([])

    symbol.signature = {
      ...sig(),
      inputs: [
        { name: "{ save }", type: "Deps", bindings: "save" },
        { name: "[a, b]", type: "", bindings: ["a", 7] },
      ],
    }
    const violations = shapeViolations(withField("symbols", [symbol]))
    expect(violations.map((v) => v.subject)).toEqual([
      "symbols[0].signature.inputs[0]",
      "symbols[0].signature.inputs[1].bindings[1]",
    ])
  })

  it("reports NaN and Infinity as themselves rather than as numbers", () => {
    const symbol = makeSymbol("ts:src/a.ts#foo") as unknown as Record<string, unknown>
    symbol.calls = [{ target: "t", line: Number.NaN, resolved: null }]
    const messages = shapeViolations(withField("symbols", [symbol])).map((v) => v.message)
    expect(messages.some((m) => m.includes("is NaN, not a finite number"))).toBe(true)
  })

  it("reports the shape alone, without the invariants derived from what is missing", () => {
    const violations = checkIRIntegrity(withField("symbols", [{}]))
    expect(violations.every((v) => v.invariant === 20)).toBe(true)
  })

  it("assertIRIntegrity reports it as an integrity violation, not a TypeError", () => {
    const document = without("workspace")
    expect(() => assertIRIntegrity(document)).toThrow(CoreError)
    expect(() => assertIRIntegrity(document)).toThrowError(
      expect.objectContaining({
        code: "integrity-violation",
        violations: [expect.objectContaining({ invariant: 20, subject: "document" })],
        message: expect.stringContaining('"workspace" is absent'),
      }),
    )
  })
})
