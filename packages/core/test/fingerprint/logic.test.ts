import type { Symbol as IRSymbol, Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { logicFingerprint, logicNamesNothing } from "../../src/index"
import { makeSymbol, symbolId } from "../fixtures/ir"

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

  it("L12a: an id change that reorders two propagated effects leaves the caller's logic alone", () => {
    // The IR sorts the propagated segment by (id, target), so db.write → x-acme:create moves
    // prisma.invoice.create from before bus.emit to after it. The callee, whose local effects
    // keep call order, keeps its hash; the caller has to as well (fingerprint.md §4.5).
    const propagated = (id: string, target: string) => ({
      id,
      target,
      plugin: "effects-test",
      confidence: "high" as const,
      derivedBy: "convention:test",
      propagated: true as const,
      derivedFrom: [symbolId("ts:src/invoice.ts#saveInvoice")],
    })
    const caller = (effects: IRSymbol["effects"]) =>
      makeSymbol("ts:src/invoice.ts#handleCheckout", { rules: [], effects })

    const before = caller([
      propagated("db.write", "prisma.invoice.create"),
      propagated("event.publish", "bus.emit"),
    ])
    const after = caller([
      propagated("event.publish", "bus.emit"),
      propagated("x-acme:create", "prisma.invoice.create"),
    ])

    expect(logicFingerprint(after)).toBe(logicFingerprint(before))
  })

  it("keeps local effects in call order ahead of the propagated ones", () => {
    // Sorting reaches the propagated segment only: swapping two local effects is still a
    // logic change (§4.7), and so is a local effect becoming a propagated one.
    const local = (target: string, line: number) => ({
      id: "db.write",
      target,
      line,
      plugin: "effects-test",
      confidence: "high" as const,
      derivedBy: "convention:test",
    })
    const sym = (effects: IRSymbol["effects"]) =>
      makeSymbol("ts:src/a.ts#f", { rules: [], effects })

    expect(logicFingerprint(sym([local("b.write", 1), local("a.write", 2)]))).not.toBe(
      logicFingerprint(sym([local("a.write", 1), local("b.write", 2)])),
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

/**
 * Whether the logic axis is evidence of identity. A rule's `type` and `loopKind` are the shape of
 * a body, which unrelated bodies share; anything else it carries, and any effect, names something.
 */
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

  it("does not read what the hash does not: a rule's line", () => {
    const at = (line: number) => withRules(shaped({ type: "try", line }))
    expect(logicFingerprint(at(3))).toBe(logicFingerprint(at(40)))
    expect(logicNamesNothing(at(40))).toBe(true)
  })
})
