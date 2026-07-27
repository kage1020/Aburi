import { describe, expect, it } from "vitest"
import { assertIRIntegrity, CoreError, checkIRIntegrity } from "../src/index"
import { makeSymbol, minimalIR } from "./fixtures/ir"

describe("checkIRIntegrity", () => {
  it("returns [] for an empty but well-formed IR", () => {
    expect(checkIRIntegrity(minimalIR())).toEqual([])
  })

  it("#1: detects duplicate Symbol ids", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo"), makeSymbol("ts:src/a.ts#foo")]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 1)).toBe(true)
  })

  it("#2: detects duplicate Component ids", () => {
    const ir = minimalIR()
    ir.components = [
      { id: "a", name: "A", roots: ["apps/a"], languages: ["ts"] },
      { id: "a", name: "A2", roots: ["apps/a2"], languages: ["ts"] },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 2)).toBe(true)
  })

  it("#3: detects unknown Symbol.component reference", () => {
    const ir = minimalIR()
    ir.components = [{ id: "billing", name: "B", roots: ["apps/billing"], languages: ["ts"] }]
    ir.symbols = [makeSymbol("ts:src/a.ts#foo", { component: "missing" })]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 3)).toBe(true)
  })

  it("#4: detects dependency endpoints that look like Symbol ids but are not declared", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo")]
    ir.dependencies = [
      {
        from: "ts:src/a.ts#foo",
        to: "ts:src/b.ts#missing",
        via: "call",
        direction: "outbound",
        effect: null,
      },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 4)).toBe(true)
  })

  it("#5: detects dropped=true with null dropReason", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo", { dropped: true, dropReason: null })]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 5)).toBe(true)
  })

  it("#6: detects invalid confidence enum", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo", { confidence: "experimental" as never })]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 6)).toBe(true)
  })

  it("#7: accepts core effect vocabulary and x-* prefix", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#foo", {
        effects: [
          {
            id: "db.write",
            target: "prisma.user.create",
            line: 1,
            plugin: "effects-prisma",
            confidence: "high",
            derivedBy: "convention:test",
          },
          {
            id: "x-stripe:charge",
            target: "stripe.charges.create",
            line: 2,
            plugin: "effects-stripe",
            confidence: "high",
            derivedBy: "convention:test",
          },
        ],
      }),
    ]
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("#7: detects effect ids that are neither core nor x-* prefixed", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#foo", {
        effects: [
          {
            id: "unknown.effect",
            target: "x",
            line: 1,
            plugin: "p",
            confidence: "high",
            derivedBy: "convention:test",
          },
        ],
      }),
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 7)).toBe(true)
  })

  it("#8: detects invalid kind enum", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo", { kind: "macro" as never })]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 8)).toBe(true)
  })

  it("#9: detects single-segment extKind (must have at least two segments)", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo", { extKind: "fponly" })]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 9)).toBe(true)
  })

  it("#9: accepts null extKind and valid multi-segment shapes", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#a", { extKind: null }),
      makeSymbol("ts:src/a.ts#b", { extKind: "framework:nestjs:controller" }),
    ]
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("#10: detects backslash paths in Symbol.source.file", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#foo", {
        source: { file: "src\\a.ts", startLine: 1, endLine: 1, startColumn: null, endColumn: null },
      }),
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 10)).toBe(true)
  })

  it("#10: detects absolute paths in component roots", () => {
    const ir = minimalIR()
    ir.components = [{ id: "a", name: "A", roots: ["/abs/path"], languages: ["ts"] }]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 10)).toBe(true)
  })

  it("#11: detects unsorted symbols[] by id", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#z"), makeSymbol("ts:src/a.ts#a")]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 11)).toBe(true)
  })

  it("#11: rejects a locally-detected effect appearing after a propagated effect", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#foo", {
        effects: [
          {
            id: "db.write",
            target: "x",
            plugin: "p",
            confidence: "high",
            derivedBy: "convention:test",
            propagated: true,
            derivedFrom: ["ts:src/a.ts#other"],
          },
          {
            id: "db.read",
            target: "y",
            line: 5,
            plugin: "p",
            confidence: "high",
            derivedBy: "convention:test",
          },
        ],
      }),
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 11)).toBe(true)
  })

  it("#11: rejects a propagated effect that carries line", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#foo", {
        effects: [
          {
            id: "db.write",
            target: "x",
            line: 3,
            plugin: "p",
            confidence: "high",
            derivedBy: "convention:test",
            propagated: true,
            derivedFrom: ["ts:src/a.ts#other"],
          },
        ],
      }),
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 11)).toBe(true)
  })

  it("#11: rejects a propagated effect missing derivedFrom", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#foo", {
        effects: [
          {
            id: "db.write",
            target: "x",
            plugin: "p",
            confidence: "high",
            derivedBy: "convention:test",
            propagated: true,
          },
        ],
      }),
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 11)).toBe(true)
  })

  it("#11: detects unsorted decorators[] by line within a Symbol", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#foo", {
        decorators: [
          { name: "B", raw: "B()", arguments: [], boundary: false, line: 10 },
          { name: "A", raw: "A()", arguments: [], boundary: false, line: 5 },
        ],
      }),
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 11)).toBe(true)
  })

  it("#12: rejects via:call edges whose from is a Component id (non-symbol shape)", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo")]
    ir.dependencies = [
      {
        from: "billing",
        to: "ts:src/a.ts#foo",
        via: "call",
        direction: "outbound",
        effect: null,
      },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 12)).toBe(true)
  })

  it("#12: rejects via:call edges whose to is a dangling Symbol id", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#foo", {
        calls: [{ target: "gone", line: 1, resolved: "ts:src/missing.ts#gone" }],
      }),
    ]
    ir.dependencies = [
      {
        from: "ts:src/a.ts#foo",
        to: "ts:src/missing.ts#gone",
        via: "call",
        direction: "outbound",
        effect: null,
      },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 12)).toBe(true)
  })

  it("#12: rejects via:call edges whose to points at a dropped Symbol", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#caller", {
        calls: [{ target: "helper", line: 1, resolved: "ts:src/a.ts#helper" }],
      }),
      makeSymbol("ts:src/a.ts#helper", { dropped: true, dropReason: "test" }),
    ]
    ir.dependencies = [
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/a.ts#helper",
        via: "call",
        direction: "outbound",
        effect: null,
      },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 12)).toBe(true)
  })

  it("#12: accepts via:call edges whose both endpoints exist in symbols[]", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#caller", {
        calls: [{ target: "helper", line: 3, resolved: "ts:src/a.ts#helper" }],
      }),
      makeSymbol("ts:src/a.ts#helper"),
    ]
    ir.dependencies = [
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/a.ts#helper",
        via: "call",
        direction: "outbound",
        effect: null,
      },
    ]
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("#13: detects duplicate (from, to, via) triples in dependencies[]", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#caller", {
        calls: [{ target: "helper", line: 3, resolved: "ts:src/a.ts#helper" }],
      }),
      makeSymbol("ts:src/a.ts#helper"),
    ]
    ir.dependencies = [
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/a.ts#helper",
        via: "call",
        direction: "outbound",
        effect: null,
      },
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/a.ts#helper",
        via: "call",
        direction: "outbound",
        effect: null,
      },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 13)).toBe(true)
  })

  it("#14: detects a resolved call with no matching via:call Dependency", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#caller", {
        calls: [{ target: "helper", line: 3, resolved: "ts:src/a.ts#helper" }],
      }),
      makeSymbol("ts:src/a.ts#helper"),
    ]
    ir.dependencies = []
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 14)).toBe(true)
  })

  it("#14: detects a via:call Dependency with no backing Symbol.calls[].resolved", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#caller"), makeSymbol("ts:src/a.ts#helper")]
    ir.dependencies = [
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/a.ts#helper",
        via: "call",
        direction: "outbound",
        effect: null,
      },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 14)).toBe(true)
  })
})

describe("invariant #15 — callResolution stats census (call-resolution.md §8.1)", () => {
  function irWithOneUnresolvedCall(): ReturnType<typeof minimalIR> {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#caller", {
        calls: [{ target: "typoed", line: 1, resolved: null }],
      }),
    ]
    ir.stats.callResolution = {
      totalCalls: 1,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 1 },
    }
    return ir
  }

  it("accepts a census that matches symbols[]", () => {
    expect(checkIRIntegrity(irWithOneUnresolvedCall())).toEqual([])
  })

  it("stays silent when the field is absent (IRs predating the counter)", () => {
    const ir = irWithOneUnresolvedCall()
    delete ir.stats.callResolution
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("flags a totalCalls that disagrees with symbols[]", () => {
    const ir = irWithOneUnresolvedCall()
    ir.stats.callResolution = {
      totalCalls: 7,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 7 },
    }
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 15)).toBe(true)
  })

  it("flags a resolvedCalls that disagrees with symbols[]", () => {
    const ir = irWithOneUnresolvedCall()
    ir.stats.callResolution = {
      totalCalls: 1,
      resolvedCalls: 1,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
    }
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 15)).toBe(true)
  })

  it("flags buckets that do not sum to the unresolved remainder", () => {
    const ir = irWithOneUnresolvedCall()
    ir.stats.callResolution = {
      totalCalls: 1,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
    }
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 15)).toBe(true)
  })
})

describe("assertIRIntegrity", () => {
  it("does not throw on a clean IR", () => {
    expect(() => assertIRIntegrity(minimalIR())).not.toThrow()
  })

  it("throws a CoreError with the full violation list attached", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo"), makeSymbol("ts:src/a.ts#foo")]
    let caught: unknown
    try {
      assertIRIntegrity(ir)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CoreError)
    expect((caught as CoreError).code).toBe("integrity-violation")
    expect((caught as CoreError).violations?.length ?? 0).toBeGreaterThan(0)
  })
})
