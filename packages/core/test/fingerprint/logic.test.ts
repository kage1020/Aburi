import { decorator, effect, rule, sig } from "@aburi/test-support"
import type { Effect, Symbol as IRSymbol, Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { logicFingerprint, logicNamesNothing } from "../../src/index"
import { makeSymbol, type SymbolOverrides } from "../fixtures/ir"

function localEffect(id: string, target: string, line: number): Effect {
  return effect({ id, target, plugin: "effects-test", line })
}

function propagatedEffect(id: string, target: string): Effect {
  return effect({
    id,
    target,
    plugin: "effects-test",
    propagated: true,
    derivedFrom: ["ts:src/invoice.ts#saveInvoice"],
  })
}

const GUARD = rule({ type: "guard", line: 3, condition: "amount <= 0" })
const THROW = rule({ type: "throw", line: 5, what: "AmountInvalid" })
const WRITE = localEffect("db.write", "prisma.invoice.create", 8)
const PUBLISH = localEffect("event.publish", "eventBus.emit", 10)

function body(overrides: SymbolOverrides = {}): IRSymbol {
  return makeSymbol("ts:src/a.ts#foo", {
    rules: [GUARD, THROW],
    effects: [WRITE, PUBLISH],
    ...overrides,
  })
}

/** A caller with no rules, so its logic input is its effects alone. */
function caller(...effects: Effect[]): IRSymbol {
  return makeSymbol("ts:src/invoice.ts#handleCheckout", { effects })
}

describe("logicFingerprint ignores", () => {
  it.each<[string, IRSymbol, IRSymbol]>([
    [
      "the Symbol's position, confidence and provenance",
      body({
        source: {
          file: "src/a.ts",
          startLine: 42,
          endLine: 99,
          startColumn: null,
          endColumn: null,
        },
        confidence: "medium",
        derivedBy: ["convention:service-suffix"],
      }),
      body(),
    ],
    ["calls", body({ calls: [{ target: "console.log", line: 12, resolved: null }] }), body()],
    ["decorators", body({ decorators: [decorator({ name: "UseGuards" })] }), body()],
    ["the signature", body({ signature: sig({ inputs: [{ name: "a", type: "A" }] }) }), body()],
    [
      "whitespace inside a rule string",
      body({ rules: [{ ...GUARD, condition: "amount  \n  <=  0" }, THROW] }),
      body(),
    ],
    [
      "a rule's line",
      body({
        rules: [
          { ...GUARD, line: 30 },
          { ...THROW, line: 50 },
        ],
      }),
      body(),
    ],
    [
      "which effect id classified a target",
      body({
        effects: [
          { ...WRITE, id: "x-prisma:create" },
          { ...PUBLISH, id: "x-nest:emit" },
        ],
      }),
      body(),
    ],
    [
      "which plugin classified a target",
      body({ effects: [{ ...WRITE, plugin: "effects-alternate" }, PUBLISH] }),
      body(),
    ],
    [
      "`propagated: false` written out on a local effect",
      caller({ ...WRITE, propagated: false }),
      caller(WRITE),
    ],
    [
      "where a propagated effect sits among the local ones",
      caller(propagatedEffect("db.write", "a.propagated"), WRITE, PUBLISH),
      caller(WRITE, PUBLISH, propagatedEffect("db.write", "a.propagated")),
    ],
    [
      "an id change that reorders two propagated effects",
      caller(
        propagatedEffect("event.publish", "bus.emit"),
        propagatedEffect("x-acme:create", "prisma.invoice.create"),
      ),
      caller(
        propagatedEffect("db.write", "prisma.invoice.create"),
        propagatedEffect("event.publish", "bus.emit"),
      ),
    ],
    [
      "the same reorder beside a local effect of the caller's own",
      caller(
        localEffect("time.now", "Date.now", 4),
        propagatedEffect("event.publish", "bus.emit"),
        propagatedEffect("x-acme:create", "prisma.invoice.create"),
      ),
      caller(
        localEffect("time.now", "Date.now", 4),
        propagatedEffect("db.write", "prisma.invoice.create"),
        propagatedEffect("event.publish", "bus.emit"),
      ),
    ],
    [
      "one propagated target reaching the caller under two ids",
      caller(
        propagatedEffect("db.write", "prisma.invoice.create"),
        propagatedEffect("x-acme:create", "prisma.invoice.create"),
      ),
      caller(propagatedEffect("db.write", "prisma.invoice.create")),
    ],
    [
      "a propagated target the caller already reaches locally, whatever its id",
      caller(WRITE, propagatedEffect("x-acme:create", "prisma.invoice.create")),
      caller(WRITE),
    ],
  ])("%s", (_what, a, b) => {
    expect(logicFingerprint(a)).toBe(logicFingerprint(b))
  })
})

describe("logicFingerprint moves with", () => {
  it.each<[string, IRSymbol, IRSymbol]>([
    ["the order of rules", body({ rules: [THROW, GUARD] }), body()],
    ["the order of local effects", body({ effects: [PUBLISH, WRITE] }), body()],
    ["a rule's condition", body({ rules: [{ ...GUARD, condition: "amount < 0" }, THROW] }), body()],
    ["a rule's thrown value", body({ rules: [GUARD, { ...THROW, what: "NotFound" }] }), body()],
    ["a rule's type", body({ rules: [{ ...GUARD, type: "return" }, THROW] }), body()],
    [
      "a rule's loop kind",
      body({ rules: [rule({ type: "loop", loopKind: "for" })] }),
      body({ rules: [rule({ type: "loop", loopKind: "while" })] }),
    ],
    [
      "a rule's expression",
      body({ rules: [rule({ type: "return", expr: "invoice" })] }),
      body({ rules: [rule({ type: "return", expr: "receipt" })] }),
    ],
    [
      "an effect's target",
      body({ effects: [{ ...WRITE, target: "prisma.customer.create" }, PUBLISH] }),
      body(),
    ],
    [
      "an added effect",
      body({ effects: [WRITE, PUBLISH, localEffect("fs.write", "fs.writeFileSync", 12)] }),
      body(),
    ],
    [
      "a propagated effect, even when it is the caller's only one",
      caller(propagatedEffect("db.write", "prisma.invoice.create")),
      caller(),
    ],
  ])("%s", (_what, a, b) => {
    expect(logicFingerprint(a)).not.toBe(logicFingerprint(b))
  })
})

describe("logicNamesNothing", () => {
  const withRules = (...rules: Rule[]) => makeSymbol("ts:src/a.ts#foo", { rules })

  it.each<[string, IRSymbol]>([
    ["a body with no rules and no effects", withRules()],
    ["a loop", withRules(rule({ type: "loop", loopKind: "for" }))],
    ["a try", withRules(rule({ type: "try" }))],
    [
      "a guard and a throw it could not read",
      withRules(rule({ type: "guard" }), rule({ type: "throw" })),
    ],
    ["a try at any line", withRules(rule({ type: "try", line: 40 }))],
  ])("holds for %s", (_what, symbol) => {
    expect(logicNamesNothing(symbol)).toBe(true)
  })

  const loop = rule({ type: "loop", loopKind: "for" })

  it.each<[string, IRSymbol]>([
    ["a rule carrying a condition", withRules(loop, rule({ type: "guard", condition: "!id" }))],
    ["a rule carrying a thrown value", withRules(loop, rule({ type: "throw", what: "Error" }))],
    ["a rule carrying an expression", withRules(loop, rule({ type: "return", expr: "a + b" }))],
    ["a local effect", caller(WRITE)],
    ["a propagated effect alone", caller(propagatedEffect("db.write", "prisma.invoice.create"))],
  ])("fails on %s", (_what, symbol) => {
    expect(logicNamesNothing(symbol)).toBe(false)
  })
})
