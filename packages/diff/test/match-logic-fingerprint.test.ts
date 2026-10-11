import { logicFingerprint } from "@aburi/core"
import { fp, guardedBody, makeSymbol, rule, sig, zeroFp } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { matchStageLogicFingerprint, matchStageNameSignature } from "../src"
import { changesBetween } from "./helpers"

const SHARED_LOGIC = "111111111111"

/** A method whose logic fingerprint names a guard, so the hash is evidence of identity. */
function withLogic(file: string, name: string, logic = SHARED_LOGIC): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind: "method",
    fingerprint: { api: "aaaaaaaaaaaa", logic, syntax: "bbbbbbbbbbbb" },
    rules: guardedBody(logic),
    signature: sig(),
  })
}

function stage3(base: readonly IRSymbol[], head: readonly IRSymbol[]) {
  const result = matchStageLogicFingerprint(base, head)
  return {
    pairs: result.matched.map((pair) => [pair.base.id, pair.head.id, pair.rationale]),
    remainingBase: result.remainingBase.map((symbol) => symbol.id),
    remainingHead: result.remainingHead.map((symbol) => symbol.id),
  }
}

describe("matchStageLogicFingerprint", () => {
  it("skips dropped Symbols, whose zeroed fingerprints would all collide", () => {
    const base = makeSymbol({
      id: "ts:a.ts#DtoA",
      name: "DtoA",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const head = makeSymbol({
      id: "ts:a.ts#DtoB",
      name: "DtoB",
      dropped: true,
      fingerprint: zeroFp(),
    })
    expect(stage3([base], [head]).pairs).toEqual([])
  })

  it("pairs a lone base with a lone head however unlike their names are", () => {
    expect(
      stage3([withLogic("src/a.ts", "Svc.alpha")], [withLogic("src/b.ts", "Other.omega")]),
    ).toEqual({
      pairs: [["ts:src/a.ts#Svc.alpha", "ts:src/b.ts#Other.omega", "logic-fingerprint"]],
      remainingBase: [],
      remainingHead: [],
    })
  })

  it("lets names decide between several bases", () => {
    const winner = withLogic("src/a.ts", "Cls.readUser")
    const loser = withLogic("src/a.ts", "Cls.somethingElse")
    expect(stage3([winner, loser], [withLogic("src/b.ts", "Cls.readUser")])).toEqual({
      pairs: [[winner.id, "ts:src/b.ts#Cls.readUser", "logic-fingerprint+name-disambiguation"]],
      remainingBase: [loser.id],
      remainingHead: [],
    })
  })

  it("leaves a group whose names cannot reach 0.85 whole for later stages", () => {
    const body = (file: string, name: string) =>
      makeSymbol({
        id: `ts:${file}#${name}`,
        name,
        kind: "class",
        fingerprint: { api: "aaaaaaaaaaaa", logic: "222222222222", syntax: "bbbbbbbbbbbb" },
        rules: guardedBody("222222222222"),
      })
    expect(
      stage3([body("src/a.ts", "Alpha"), body("src/b.ts", "Beta")], [body("src/c.ts", "Gamma")])
        .pairs,
    ).toEqual([])
  })

  it("pairs the base a scored round leaves alone unconditionally", () => {
    expect(
      changesBetween(
        [withLogic("src/a.ts", "Svc.createOrder"), withLogic("src/b.ts", "Svc.zzz")],
        [withLogic("src/c.ts", "Svc.createOrder"), withLogic("src/d.ts", "Svc.qqq")],
      ),
    ).toEqual([
      "moved ts:src/a.ts#Svc.createOrder -> ts:src/c.ts#Svc.createOrder",
      "moved ts:src/b.ts#Svc.zzz -> ts:src/d.ts#Svc.qqq",
    ])
  })

  it.each([
    [
      "one base is the closer name",
      [withLogic("src/zzz.ts", "Svc.createOrder"), withLogic("src/aaa.ts", "Svc.deleteInvoice")],
      [withLogic("src/mid.ts", "Svc.createOrder")],
      [
        "moved ts:src/zzz.ts#Svc.createOrder -> ts:src/mid.ts#Svc.createOrder",
        "removed ts:src/aaa.ts#Svc.deleteInvoice",
      ],
    ],
    [
      "two bases tie, settling on the lower base id",
      [withLogic("src/aaa.ts", "Svc.createOrder"), withLogic("src/zzz.ts", "Svc.createOrder")],
      [withLogic("src/mid.ts", "Svc.createOrder")],
      [
        "moved ts:src/aaa.ts#Svc.createOrder -> ts:src/mid.ts#Svc.createOrder",
        "removed ts:src/zzz.ts#Svc.createOrder",
      ],
    ],
    [
      "a lone base has one closer head",
      [withLogic("src/a.ts", "Svc.createOrder")],
      [withLogic("src/b.ts", "Svc.createOrder"), withLogic("src/c.ts", "Other.omega")],
      [
        "added ts:src/c.ts#Other.omega",
        "moved ts:src/a.ts#Svc.createOrder -> ts:src/b.ts#Svc.createOrder",
      ],
    ],
    [
      "a lone base has two heads that tie, settling on the lower head id",
      [withLogic("src/mid.ts", "Svc.createOrder")],
      [withLogic("src/aaa.ts", "Svc.createOrder"), withLogic("src/zzz.ts", "Svc.createOrder")],
      [
        "added ts:src/zzz.ts#Svc.createOrder",
        "moved ts:src/mid.ts#Svc.createOrder -> ts:src/aaa.ts#Svc.createOrder",
      ],
    ],
  ])("answers the same whichever way the arrays are written when %s", (_, base, head, expected) => {
    expect(changesBetween(base, head)).toEqual(expected)
    expect(changesBetween([...base].reverse(), [...head].reverse())).toEqual(expected)
  })
})

describe("matchStageLogicFingerprint over a logic fingerprint that names nothing", () => {
  const symbolAt = (
    file: string,
    name: string,
    kind: IRSymbol["kind"],
    rules: IRSymbol["rules"],
  ) => {
    const shape = makeSymbol({ id: `ts:${file}#${name}`, name, kind, rules })
    return makeSymbol({ ...shape, fingerprint: { ...fp("same"), logic: logicFingerprint(shape) } })
  }
  const at = (file: string, name: string, kind: IRSymbol["kind"] = "function") =>
    symbolAt(file, name, kind, [])

  it.each([
    ["an unrelated class", at("src/invoice.ts", "InvoiceRenderer", "class")],
    ["an unrelated function", at("src/invoice.ts", "renderInvoiceTotal")],
  ])("does not pair a lone deleted function with %s", (_, head) => {
    const base = at("src/mail.ts", "sendWelcomeEmail")
    expect(stage3([base], [head])).toEqual({
      pairs: [],
      remainingBase: [base.id],
      remainingHead: [head.id],
    })
  })

  it.each([
    ["one `for` loop", rule({ type: "loop", loopKind: "for" })],
    ["one `try`", rule({ type: "try" })],
  ])("treats a body of only %s as naming nothing", (_, shape) => {
    const base = symbolAt("src/mail.ts", "sendAllEmails", "function", [shape])
    const head = symbolAt("src/invoice.ts", "renderInvoiceRows", "function", [shape])
    expect(base.fingerprint.logic).toBe(head.fingerprint.logic)
    expect(stage3([base], [head]).pairs).toEqual([])
  })

  it("leaves two unrelated top-level `main`s apart", () => {
    expect(stage3([at("src/tool-a.ts", "main")], [at("src/tool-b.ts", "main")]).pairs).toEqual([])
  })

  it("pairs a class whose name says two words when it moves file", () => {
    const base = at("src/old.ts", "InvoiceRenderer", "class")
    const head = at("src/new.ts", "InvoiceRenderer", "class")
    expect(stage3([base], [head]).pairs).toEqual([
      [base.id, head.id, "logic-fingerprint+name-disambiguation"],
    ])
  })

  it("leaves a class whose name says one word apart, while its method pairs", () => {
    const oldMethod = at("src/old.ts", "Invoice.render", "method")
    const newMethod = at("src/new.ts", "Invoice.render", "method")
    expect(
      stage3(
        [at("src/old.ts", "Invoice", "class"), oldMethod],
        [at("src/new.ts", "Invoice", "class"), newMethod],
      ),
    ).toEqual({
      pairs: [[oldMethod.id, newMethod.id, "logic-fingerprint+name-disambiguation"]],
      remainingBase: ["ts:src/old.ts#Invoice"],
      remainingHead: ["ts:src/new.ts#Invoice"],
    })
  })

  it("keeps a function and a class of one admissible name apart on their kind alone", () => {
    expect(
      stage3(
        [at("src/a.ts", "InvoiceRenderer", "function")],
        [at("src/b.ts", "InvoiceRenderer", "class")],
      ).pairs,
    ).toEqual([])
  })

  it("holds the 0.85 bar: 6/7 of a name pairs, 5/6 does not", () => {
    const base = at("src/a.ts", "fetchUserAccountBillingInvoiceTotal")
    const longer = at("src/b.ts", "fetchUserAccountBillingInvoiceTotalAmount")
    expect(stage3([base], [longer]).pairs).toEqual([
      [base.id, longer.id, "logic-fingerprint+name-disambiguation"],
    ])
    expect(stage3([base], [at("src/b.ts", "fetchUserAccountBillingInvoice")]).pairs).toEqual([])
  })

  it("refuses a pair below the bar whether or not its base was the last one left", () => {
    const moved = at("src/a.ts", "parseAmount")
    const renamed = at("src/b.ts", "parseAmountValue")
    expect(stage3([moved], [renamed]).pairs).toEqual([])
    expect(stage3([moved, at("src/audit.ts", "flushAuditLog")], [renamed]).pairs).toEqual([])
  })

  it("does not fall back to pairing a lone base after a scored round", () => {
    const before = at("src/a.ts", "createOrderEntry")
    const after = at("src/b.ts", "createOrderEntry")
    expect(
      stage3(
        [before, at("src/mail.ts", "sendWelcomeEmail")],
        [after, at("src/invoice.ts", "renderInvoiceTotal")],
      ),
    ).toEqual({
      pairs: [[before.id, after.id, "logic-fingerprint+name-disambiguation"]],
      remainingBase: ["ts:src/mail.ts#sendWelcomeEmail"],
      remainingHead: ["ts:src/invoice.ts#renderInvoiceTotal"],
    })
  })

  it("leaves a renamed call-only method to stage 4, which refuses it too", () => {
    const base = makeSymbol({ ...at("src/a.ts", "Cls.getUser", "method"), signature: sig() })
    const head = makeSymbol({ ...at("src/a.ts", "Cls.fetchUser", "method"), signature: sig() })
    const afterStage3 = matchStageLogicFingerprint([base], [head])
    expect(afterStage3.matched).toEqual([])
    expect(
      matchStageNameSignature(afterStage3.remainingBase, afterStage3.remainingHead).matched,
    ).toEqual([])
  })
})

describe("matchStageLogicFingerprint across kinds", () => {
  const body = (id: string, kind: IRSymbol["kind"], over: Partial<IRSymbol> = {}) =>
    makeSymbol({
      id,
      name: id.slice(id.indexOf("#") + 1),
      kind,
      fingerprint: fp("shared"),
      rules: guardedBody("total > 0"),
      ...over,
    })

  it("never pairs across kinds, even on a fingerprint that names something", () => {
    expect(
      matchStageLogicFingerprint([body("ts:a.ts#Foo", "function")], [body("ts:b.ts#Foo", "class")])
        .matched,
    ).toEqual([])
  })

  it.each([
    [
      "a method extracted into a function",
      body("ts:src/a.ts#Cart.computeTotal", "method", { signature: sig() }),
      body("ts:src/b.ts#computeTotal", "function", { signature: sig() }),
    ],
    [
      "an enum rewritten as a `const` in another file",
      makeSymbol({ id: "ts:src/a.ts#OrderStatus", name: "OrderStatus", kind: "enum" }),
      makeSymbol({ id: "ts:src/b.ts#OrderStatus", name: "OrderStatus", kind: "const" }),
    ],
  ])("gives up %s, which stage 4 does not take either", (_, base, head) => {
    const afterStage3 = matchStageLogicFingerprint([base], [head])
    expect(afterStage3.matched).toEqual([])
    expect(
      matchStageNameSignature(afterStage3.remainingBase, afterStage3.remainingHead).matched,
    ).toEqual([])
  })
})
