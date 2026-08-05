import { describe, expect, it } from "vitest"
import { makeLanguageId } from "../src/id"
import { assertIRIntegrity, CoreError, checkIRIntegrity } from "../src/index"
import {
  componentId,
  endpoint,
  makeComponent,
  makeDependency,
  makeSymbol,
  minimalIR,
  symbolId,
} from "./fixtures/ir"
import { WORKSPACE_PATH_CASES } from "./fixtures/paths"

/** A `Symbol.source` whose only interesting field is the path under test. */
function sourceAt(file: string) {
  return { file, startLine: 1, endLine: 1, startColumn: null, endColumn: null }
}

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
      { id: componentId("a"), name: "A", roots: ["apps/a"], languages: [makeLanguageId("ts")] },
      { id: componentId("a"), name: "A2", roots: ["apps/a2"], languages: [makeLanguageId("ts")] },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 2)).toBe(true)
  })

  it("#3: detects unknown Symbol.component reference", () => {
    const ir = minimalIR()
    ir.components = [
      {
        id: componentId("billing"),
        name: "B",
        roots: ["apps/billing"],
        languages: [makeLanguageId("ts")],
      },
    ]
    ir.symbols = [makeSymbol("ts:src/a.ts#foo", { component: "missing" })]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 3)).toBe(true)
  })

  it("#4: detects dependency endpoints that look like Symbol ids but are not declared", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo")]
    ir.dependencies = [
      {
        from: endpoint("ts:src/a.ts#foo"),
        to: endpoint("ts:src/b.ts#missing"),
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
    ir.components = [
      { id: componentId("a"), name: "A", roots: ["/abs/path"], languages: [makeLanguageId("ts")] },
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 10)).toBe(true)
  })

  it("#10: answers the shared workspace-path table at every path site", () => {
    // Invariant #10 is what stands between a document Aburi did not write and the passes
    // that use its paths directly — `aburi diff --base <ir.json>` resolves them off disk.
    // A path the Symbol id constructor refuses has to be refused here as well, at all three
    // sites, or a hand-edited IR reintroduces exactly what the constructor kept out.
    for (const { path, rejected, why } of WORKSPACE_PATH_CASES) {
      const ir = minimalIR()
      ir.components = [makeComponent("a", { roots: [path] })]
      ir.symbols = [makeSymbol("ts:src/a.ts#foo", { source: sourceAt(path) })]
      ir.workspace.managers = [{ tool: "pnpm", roots: [path] }]

      const subjects = checkIRIntegrity(ir)
        .filter((v) => v.invariant === 10)
        .map((v) => v.subject)
        .sort()
      const label = `${JSON.stringify(path)} (${why})`
      expect(subjects, label).toEqual(
        rejected
          ? ["components[id=a].roots", "ts:src/a.ts#foo", "workspace.managers[tool=pnpm].roots"]
          : [],
      )
    }
  })

  it("#17: detects a Symbol id whose qualified name has an empty segment", () => {
    // `ts:src/a.ts#A.` used to satisfy every invariant and then throw out of `apiFingerprint`,
    // where `lastQnameSegment` found the leaf empty. The id grammar is where that is caught.
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#A.")]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 17)).toBe(true)
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
            derivedFrom: [symbolId("ts:src/a.ts#other")],
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
            derivedFrom: [symbolId("ts:src/a.ts#other")],
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
        from: endpoint("billing"),
        to: endpoint("ts:src/a.ts#foo"),
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
        from: endpoint("ts:src/a.ts#foo"),
        to: endpoint("ts:src/missing.ts#gone"),
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
        from: endpoint("ts:src/a.ts#caller"),
        to: endpoint("ts:src/a.ts#helper"),
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
        from: endpoint("ts:src/a.ts#caller"),
        to: endpoint("ts:src/a.ts#helper"),
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
        from: endpoint("ts:src/a.ts#caller"),
        to: endpoint("ts:src/a.ts#helper"),
        via: "call",
        direction: "outbound",
        effect: null,
      },
      {
        from: endpoint("ts:src/a.ts#caller"),
        to: endpoint("ts:src/a.ts#helper"),
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
        from: endpoint("ts:src/a.ts#caller"),
        to: endpoint("ts:src/a.ts#helper"),
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

describe("checkIRIntegrity — id namespaces (#16)", () => {
  it("#16: rejects a Symbol id in the reserved `slice:` namespace", () => {
    // makeSymbolId refuses to build one, so this can only arrive from a document Aburi did
    // not produce. Left unchecked, computeSlices would derive "slice:slice:src/a.ts#foo".
    const ir = minimalIR()
    ir.symbols = [makeSymbol("slice:src/a.ts#foo")]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 16)).toBe(true)
  })

  it("#16: leaves ordinary language tokens alone, including ones with the reserved prefix", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("slicer:src/a.ts#foo"), makeSymbol("ts:src/b.ts#bar")]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 16)).toBe(false)
  })

  it("#16: covers Dependency endpoints, not just symbols[]", () => {
    // Without this, the endpoint is reported by #4 as a Symbol id with no matching Symbol —
    // detected, but blamed on a missing Symbol that was never supposed to exist.
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#foo")]
    ir.dependencies = [
      makeDependency({ from: "ts:src/a.ts#foo", to: "slice:src/b.ts#bar", via: "import" }),
    ]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 16)).toBe(true)
  })

  it("#17: rejects a Symbol id that no constructor could have produced", () => {
    // readIR brands a whole document in one assertion, so this is the only place the ids
    // inside it are actually looked at.
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:../../etc/passwd#foo")]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 17)).toBe(true)
  })

  it("#17: rejects a Component id that is not kebab-case", () => {
    const ir = minimalIR()
    ir.components = [makeComponent("Billing")]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 17)).toBe(true)
  })

  it("#17: accepts the ids the constructors produce, including digit-leading components", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#Cls::fromJson", { component: "3d-renderer" }),
      makeSymbol("ts:src/b.ts#<default>", { component: "3d-renderer" }),
    ]
    ir.components = [makeComponent("3d-renderer")]
    const violations = checkIRIntegrity(ir)
    expect(violations.filter((v) => v.invariant === 17)).toEqual([])
  })
})

describe("invariant #18 — workspace.languages", () => {
  it("rejects an empty list", () => {
    const ir = minimalIR()
    ir.workspace.languages = []
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 18)).toBe(true)
  })

  it("rejects a plugin manifest name in place of a LanguageId", () => {
    const ir = minimalIR()
    // The exact value `scan` used to project here: hyphenated, so it fails the
    // `^[a-z][a-z0-9]*$` grammar the field is typed with.
    ir.workspace.languages = ["lang-typescript" as unknown as (typeof ir.workspace.languages)[0]]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 18)).toBe(true)
  })

  it("rejects a Symbol whose language is absent from the declared list", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("py:src/a.py#alpha", { language: makeLanguageId("py") })]
    const violations = checkIRIntegrity(ir)
    expect(violations.some((v) => v.invariant === 18 && v.subject === "py:src/a.py#alpha")).toBe(
      true,
    )
  })

  it("accepts a declared language that produced no Symbol", () => {
    const ir = minimalIR()
    ir.workspace.languages = [makeLanguageId("ts"), makeLanguageId("py")]
    ir.symbols = [makeSymbol("ts:src/a.ts#alpha")]
    expect(checkIRIntegrity(ir).filter((v) => v.invariant === 18)).toEqual([])
  })
})
