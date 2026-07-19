import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { logicFingerprint } from "../../src/index"
import { makeSymbol } from "../fixtures/ir"

function base(): IRSymbol {
  return makeSymbol("ts:src/a.ts#foo", {
    rules: [
      { type: "guard", line: 3, condition: "amount <= 0", what: null, expr: null, loopKind: null },
      {
        type: "throw",
        line: 5,
        condition: null,
        what: "AmountInvalid",
        expr: null,
        loopKind: null,
      },
    ],
    effects: [
      {
        id: "db.write",
        target: "prisma.invoice.create",
        line: 8,
        plugin: "effects-prisma",
        confidence: "high",
        derivedBy: "convention:test",
      },
      {
        id: "event.publish",
        target: "eventBus.emit",
        line: 10,
        plugin: "effects-nest",
        confidence: "high",
        derivedBy: "convention:test",
      },
    ],
  })
}

describe("logicFingerprint — 12-hex determinism", () => {
  it("returns exactly 12 lowercase hex characters", () => {
    expect(logicFingerprint(base())).toMatch(/^[0-9a-f]{12}$/)
  })

  it("T1: two calls on the same Symbol produce the same hash", () => {
    const sym = base()
    expect(logicFingerprint(sym)).toBe(logicFingerprint(sym))
  })
})

describe("logicFingerprint — invariance", () => {
  const baseFp = logicFingerprint(base())

  it("L1: renaming a local variable that does not appear in any rule/effect string is invariant", () => {
    // At the fingerprint layer the "rename" surfaces as: Symbol fields that are NOT part
    // of the logic input change, but the rule/effect strings stay byte-identical. Touch
    // source line span, confidence, and derivedBy — all of which the IR carries but the
    // logic axis excludes.
    const sym = makeSymbol(base().id, {
      ...base(),
      source: {
        file: "src/a.ts",
        startLine: 42,
        endLine: 99,
        startColumn: null,
        endColumn: null,
      },
      confidence: "medium",
      derivedBy: ["convention:service-suffix"],
    })
    expect(logicFingerprint(sym)).toBe(baseFp)
  })

  it("L4: adding a call is invariant (calls are not on the logic axis)", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      calls: [{ target: "console.log", line: 12, resolved: null }],
    })
    expect(logicFingerprint(sym)).toBe(baseFp)
  })

  it("L5: changing decorators is invariant", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "UseGuards",
          raw: "UseGuards(RolesGuard)",
          arguments: ["RolesGuard"],
          boundary: false,
          line: 1,
        },
      ],
    })
    expect(logicFingerprint(sym)).toBe(baseFp)
  })

  it("L11: changing effects[].id but keeping the target is invariant (plugin-classification churn resistance)", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      effects: [
        // Same target as base, reclassified from db.write to x-prisma:create.
        {
          id: "x-prisma:create",
          target: "prisma.invoice.create",
          line: 8,
          plugin: "effects-prisma",
          confidence: "high",
          derivedBy: "convention:test",
        },
        {
          id: "x-nest:emit",
          target: "eventBus.emit",
          line: 10,
          plugin: "effects-nest",
          confidence: "high",
          derivedBy: "convention:test",
        },
      ],
    })
    expect(logicFingerprint(sym)).toBe(baseFp)
  })

  it("L12: reordering the effects plugin lineup that produces the same targets is invariant", () => {
    // Swap the plugin field (mirrors config.effects[] priority reshuffle) but keep target
    // strings identical — logic axis must ignore this.
    const sym = makeSymbol(base().id, {
      ...base(),
      effects: [
        {
          id: "db.write",
          target: "prisma.invoice.create",
          line: 8,
          plugin: "effects-alternate",
          confidence: "high",
          derivedBy: "convention:test",
        },
        {
          id: "event.publish",
          target: "eventBus.emit",
          line: 10,
          plugin: "effects-alternate",
          confidence: "high",
          derivedBy: "convention:test",
        },
      ],
    })
    expect(logicFingerprint(sym)).toBe(baseFp)
  })

  it("whitespace-only differences in rule condition strings are invariant", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      rules: [
        // Insert a newline and extra spaces — normalizeFingerprintString collapses them.
        {
          type: "guard",
          line: 3,
          condition: "amount  \n  <=  0",
          what: null,
          expr: null,
          loopKind: null,
        },
        {
          type: "throw",
          line: 5,
          condition: null,
          what: "AmountInvalid",
          expr: null,
          loopKind: null,
        },
      ],
    })
    expect(logicFingerprint(sym)).toBe(baseFp)
  })
})

describe("logicFingerprint — change conditions", () => {
  const baseFp = logicFingerprint(base())

  it("L6: swapping rule order perturbs the hash (control flow order matters)", () => {
    const sym = makeSymbol(base().id, { ...base(), rules: [...base().rules].reverse() })
    expect(logicFingerprint(sym)).not.toBe(baseFp)
  })

  it("L7: swapping effect order perturbs the hash (side effect order matters)", () => {
    const sym = makeSymbol(base().id, { ...base(), effects: [...base().effects].reverse() })
    expect(logicFingerprint(sym)).not.toBe(baseFp)
  })

  it("L8: changing a rule condition perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      rules: [
        { type: "guard", line: 3, condition: "amount < 0", what: null, expr: null, loopKind: null },
        {
          type: "throw",
          line: 5,
          condition: null,
          what: "AmountInvalid",
          expr: null,
          loopKind: null,
        },
      ],
    })
    expect(logicFingerprint(sym)).not.toBe(baseFp)
  })

  it("L9: changing effect.target perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      effects: [
        {
          id: "db.write",
          target: "prisma.customer.create",
          line: 8,
          plugin: "effects-prisma",
          confidence: "high",
          derivedBy: "convention:test",
        },
        {
          id: "event.publish",
          target: "eventBus.emit",
          line: 10,
          plugin: "effects-nest",
          confidence: "high",
          derivedBy: "convention:test",
        },
      ],
    })
    expect(logicFingerprint(sym)).not.toBe(baseFp)
  })

  it("L10: adding an effect perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      effects: [
        ...base().effects,
        {
          id: "fs.write",
          target: "fs.writeFileSync",
          line: 12,
          plugin: "effects-fs",
          confidence: "high",
          derivedBy: "convention:test",
        },
      ],
    })
    expect(logicFingerprint(sym)).not.toBe(baseFp)
  })

  it("L8b: changing Rule.what perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      rules: [
        {
          type: "guard",
          line: 3,
          condition: "amount <= 0",
          what: null,
          expr: null,
          loopKind: null,
        },
        // Only the `what` string changed vs the base's throw rule.
        {
          type: "throw",
          line: 5,
          condition: null,
          what: "NotFound",
          expr: null,
          loopKind: null,
        },
      ],
    })
    expect(logicFingerprint(sym)).not.toBe(baseFp)
  })

  it("L8c: changing Rule.type perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      rules: [
        // Same shape as the base guard but re-typed as `return`.
        {
          type: "return",
          line: 3,
          condition: "amount <= 0",
          what: null,
          expr: null,
          loopKind: null,
        },
        {
          type: "throw",
          line: 5,
          condition: null,
          what: "AmountInvalid",
          expr: null,
          loopKind: null,
        },
      ],
    })
    expect(logicFingerprint(sym)).not.toBe(baseFp)
  })

  it("L8d: changing Rule.loopKind perturbs the hash", () => {
    const withFor = makeSymbol(base().id, {
      ...base(),
      rules: [
        {
          type: "loop",
          line: 3,
          condition: null,
          what: null,
          expr: null,
          loopKind: "for",
        },
      ],
    })
    const withWhile = makeSymbol(base().id, {
      ...base(),
      rules: [
        {
          type: "loop",
          line: 3,
          condition: null,
          what: null,
          expr: null,
          loopKind: "while",
        },
      ],
    })
    expect(logicFingerprint(withFor)).not.toBe(logicFingerprint(withWhile))
  })

  it("L8e: changing Rule.expr perturbs the hash", () => {
    const a = makeSymbol(base().id, {
      ...base(),
      rules: [
        { type: "return", line: 3, condition: null, what: null, expr: "invoice", loopKind: null },
      ],
    })
    const b = makeSymbol(base().id, {
      ...base(),
      rules: [
        { type: "return", line: 3, condition: null, what: null, expr: "receipt", loopKind: null },
      ],
    })
    expect(logicFingerprint(a)).not.toBe(logicFingerprint(b))
  })
})
