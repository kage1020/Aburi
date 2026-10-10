import type { Effect, Symbol as IRSymbol, Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { hashCanonicalObject, logicFingerprint, logicNamesNothing } from "../../src/index"
import { makeSymbol, symbolId } from "../fixtures/ir"

/** A locally-detected effect: the plugin classified a call in this body, at `line`. */
function localEffect(id: string, target: string, line: number): Effect {
  return {
    id,
    target,
    line,
    plugin: "effects-test",
    confidence: "high",
    derivedBy: "convention:test",
  }
}

/** A propagated effect as the propagation pass writes one: no `line`, a direct callee. */
function propagatedEffect(id: string, target: string): Effect {
  return {
    id,
    target,
    plugin: "effects-test",
    confidence: "high",
    derivedBy: "convention:test",
    propagated: true,
    derivedFrom: [symbolId("ts:src/invoice.ts#saveInvoice")],
  }
}

/** A caller with no rules, so its logic input is its effects alone. */
function caller(effects: Effect[]): IRSymbol {
  return makeSymbol("ts:src/invoice.ts#handleCheckout", { rules: [], effects })
}

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

describe("logicFingerprint — invariance", () => {
  const baseFp = logicFingerprint(base())

  it("L1: renaming a local variable that does not appear in any rule/effect string is invariant", () => {
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

  it("L12a: an id change that reorders two propagated effects leaves the caller's logic alone", () => {
    const before = caller([
      propagatedEffect("db.write", "prisma.invoice.create"),
      propagatedEffect("event.publish", "bus.emit"),
    ])
    const after = caller([
      propagatedEffect("event.publish", "bus.emit"),
      propagatedEffect("x-acme:create", "prisma.invoice.create"),
    ])

    expect(logicFingerprint(after)).toBe(logicFingerprint(before))
  })

  it("L12a: the same reorder leaves the caller's logic alone beside a local effect of its own", () => {
    const readsClock = localEffect("time.now", "Date.now", 4)
    const before = caller([
      readsClock,
      propagatedEffect("db.write", "prisma.invoice.create"),
      propagatedEffect("event.publish", "bus.emit"),
    ])
    const after = caller([
      readsClock,
      propagatedEffect("event.publish", "bus.emit"),
      propagatedEffect("x-acme:create", "prisma.invoice.create"),
    ])

    expect(logicFingerprint(after)).toBe(logicFingerprint(before))
  })

  it("L12b: one target reaching a caller under two ids hashes as it does once the ids agree", () => {
    const split = caller([
      propagatedEffect("db.write", "prisma.invoice.create"),
      propagatedEffect("x-acme:create", "prisma.invoice.create"),
    ])
    const unified = caller([propagatedEffect("db.write", "prisma.invoice.create")])

    expect(logicFingerprint(split)).toBe(logicFingerprint(unified))
  })

  it("L12c: a propagated target the caller already calls locally adds nothing, whatever its id", () => {
    const own = localEffect("db.write", "prisma.invoice.create", 6)
    const split = caller([own, propagatedEffect("x-acme:create", "prisma.invoice.create")])
    const unified = caller([own])

    expect(logicFingerprint(split)).toBe(logicFingerprint(unified))
  })

  it("keeps local effects in call order ahead of the propagated ones", () => {
    const sym = caller([
      localEffect("db.write", "z.local", 3),
      { ...localEffect("db.write", "m.local", 5), propagated: false },
      propagatedEffect("db.write", "a.propagated"),
    ])

    expect(logicFingerprint(sym)).toBe(
      hashCanonicalObject({
        effects: [{ target: "z.local" }, { target: "m.local" }, { target: "a.propagated" }],
        rules: [],
      }),
    )
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

  it("L10: a propagated effect enters the hash, so a caller whose only effect is one moves", () => {
    const reachesWrite = caller([propagatedEffect("db.write", "prisma.invoice.create")])
    expect(logicFingerprint(reachesWrite)).not.toBe(logicFingerprint(caller([])))
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

describe("logicNamesNothing", () => {
  const shaped = (over: Partial<Rule> & Pick<Rule, "type">): Rule => ({
    line: 3,
    condition: null,
    what: null,
    expr: null,
    loopKind: null,
    ...over,
  })
  const withRules = (...rules: Rule[]) => makeSymbol("ts:src/a.ts#foo", { rules, effects: [] })

  it("holds for a body with no rules and no effects", () => {
    expect(logicNamesNothing(withRules())).toBe(true)
  })

  it("holds for bodies that are only shape: a loop, a try, a guard or throw it could not read", () => {
    expect(logicNamesNothing(withRules(shaped({ type: "loop", loopKind: "for" })))).toBe(true)
    expect(logicNamesNothing(withRules(shaped({ type: "try" })))).toBe(true)
    expect(logicNamesNothing(withRules(shaped({ type: "guard" }), shaped({ type: "throw" })))).toBe(
      true,
    )
  })

  it("fails as soon as one rule carries a condition, a thrown value or an expression", () => {
    const loop = shaped({ type: "loop", loopKind: "for" })
    expect(logicNamesNothing(withRules(loop, shaped({ type: "guard", condition: "!id" })))).toBe(
      false,
    )
    expect(logicNamesNothing(withRules(loop, shaped({ type: "throw", what: "Error" })))).toBe(false)
    expect(logicNamesNothing(withRules(loop, shaped({ type: "return", expr: "a + b" })))).toBe(
      false,
    )
  })

  it("fails on any effect, the rules notwithstanding", () => {
    const { effects } = base()
    expect(logicNamesNothing(makeSymbol(base().id, { rules: [], effects }))).toBe(false)
  })

  it("fails on a propagated effect alone", () => {
    const reachesWrite = caller([propagatedEffect("db.write", "prisma.invoice.create")])
    expect(logicNamesNothing(reachesWrite)).toBe(false)
  })

  it("does not read what the hash does not: a rule's line", () => {
    const at = (line: number) => withRules(shaped({ type: "try", line }))
    expect(logicFingerprint(at(3))).toBe(logicFingerprint(at(40)))
    expect(logicNamesNothing(at(40))).toBe(true)
  })
})
