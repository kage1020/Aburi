import { logicFingerprint } from "@aburi/core"
import { fp, guardedBody, makeSymbol, rule, sig, zeroFp } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  matchStageGitRename,
  matchStageId,
  matchStageLogicFingerprint,
  matchStageNameSignature,
} from "../src"

describe("matchStageId", () => {
  it("pairs same-id symbols and leaves the rest", () => {
    const shared = makeSymbol({ id: "ts:a.ts#Foo", name: "Foo" })
    const baseOnly = makeSymbol({ id: "ts:a.ts#Bar", name: "Bar" })
    const headOnly = makeSymbol({ id: "ts:a.ts#Baz", name: "Baz" })
    const result = matchStageId([shared, baseOnly], [shared, headOnly])
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.rationale).toBe("id-match")
    expect(result.remainingBase).toEqual([baseOnly])
    expect(result.remainingHead).toEqual([headOnly])
  })
})

describe("matchStageGitRename", () => {
  it("re-pairs symbols when rename map maps old path to new path", () => {
    const b = makeSymbol({ id: "ts:src/old.ts#Foo", name: "Foo" })
    const h = makeSymbol({ id: "ts:src/new.ts#Foo", name: "Foo" })
    const result = matchStageGitRename([b], [h], new Map([["src/old.ts", "src/new.ts"]]))
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.rationale).toBe("git-rename")
    expect(result.remainingBase).toEqual([])
    expect(result.remainingHead).toEqual([])
  })

  it("moves a private member, whose qualified name carries a `#` of its own", () => {
    const b = makeSymbol({ id: "ts:src/old.ts#C.#v", name: "C.#v" })
    const h = makeSymbol({ id: "ts:src/new.ts#C.#v", name: "C.#v" })
    const result = matchStageGitRename([b], [h], new Map([["src/old.ts", "src/new.ts"]]))
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.rationale).toBe("git-rename")
  })

  it("skips when rename map is null", () => {
    const b = makeSymbol({ id: "ts:src/old.ts#Foo", name: "Foo" })
    const h = makeSymbol({ id: "ts:src/new.ts#Foo", name: "Foo" })
    const result = matchStageGitRename([b], [h], null)
    expect(result.matched).toEqual([])
    expect(result.remainingBase).toEqual([b])
    expect(result.remainingHead).toEqual([h])
  })
})

describe("matchStageLogicFingerprint", () => {
  it("skips dropped symbols even when logic fp collides on zeros", () => {
    const b = makeSymbol({
      id: "ts:a.ts#DtoA",
      name: "DtoA",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const h = makeSymbol({
      id: "ts:a.ts#DtoB",
      name: "DtoB",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const result = matchStageLogicFingerprint([b], [h])
    expect(result.matched).toEqual([])
    expect(result.remainingBase).toEqual([b])
    expect(result.remainingHead).toEqual([h])
  })

  it("pairs single-candidate logic-fp matches", () => {
    const shared = fp("shared")
    const rules = guardedBody("ready")
    const b = makeSymbol({ id: "ts:a.ts#Foo", name: "Foo", fingerprint: shared, rules })
    const h = makeSymbol({ id: "ts:a.ts#Bar", name: "Bar", fingerprint: shared, rules })
    const result = matchStageLogicFingerprint([b], [h])
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.rationale).toBe("logic-fingerprint")
    expect(result.remainingBase).toEqual([])
    expect(result.remainingHead).toEqual([])
  })

  it("uses name similarity to disambiguate multi-candidate buckets", () => {
    const shared = fp("shared")
    const winner = makeSymbol({
      id: "ts:src/a.ts#Cls.readUser",
      name: "Cls.readUser",
      fingerprint: shared,
    })
    const loser = makeSymbol({
      id: "ts:src/a.ts#Cls.somethingElse",
      name: "Cls.somethingElse",
      fingerprint: shared,
    })
    const h = makeSymbol({
      id: "ts:src/b.ts#Cls.readUser",
      name: "Cls.readUser",
      fingerprint: shared,
      source: {
        file: "src/b.ts",
        startLine: 1,
        endLine: 10,
        startColumn: null,
        endColumn: null,
      },
    })
    const result = matchStageLogicFingerprint([winner, loser], [h])
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.base.id).toBe(winner.id)
    expect(result.matched[0]?.rationale).toBe("logic-fingerprint+name-disambiguation")
  })
})

describe("matchStageLogicFingerprint — a logic axis that names nothing", () => {
  const symbolAt = (
    file: string,
    name: string,
    kind: IRSymbol["kind"],
    rules: IRSymbol["rules"],
  ) => {
    const shape = makeSymbol({ id: `ts:${file}#${name}`, name, kind, rules })
    return makeSymbol({
      ...shape,
      id: shape.id,
      fingerprint: { ...fp("same"), logic: logicFingerprint(shape) },
      source: { file, startLine: 1, endLine: 3, startColumn: null, endColumn: null },
    })
  }
  const at = (file: string, name: string, kind: IRSymbol["kind"] = "function") =>
    symbolAt(file, name, kind, [])
  const stage3 = (base: IRSymbol[], head: IRSymbol[]) => {
    const result = matchStageLogicFingerprint(base, head)
    return {
      pairs: result.matched.map((pair) => [pair.base.id, pair.head.id, pair.rationale]),
      remainingBase: result.remainingBase.map((symbol) => symbol.id),
      remainingHead: result.remainingHead.map((symbol) => symbol.id),
    }
  }

  it("DF19f: does not pair a lone deleted function with an unrelated class", () => {
    expect(
      stage3(
        [at("src/mail.ts", "sendWelcomeEmail")],
        [at("src/invoice.ts", "InvoiceRenderer", "class")],
      ),
    ).toEqual({
      pairs: [],
      remainingBase: ["ts:src/mail.ts#sendWelcomeEmail"],
      remainingHead: ["ts:src/invoice.ts#InvoiceRenderer"],
    })
  })

  it("DF19h: does not pair it with an unrelated function either (no lone-base shortcut)", () => {
    expect(
      stage3([at("src/mail.ts", "sendWelcomeEmail")], [at("src/invoice.ts", "renderInvoiceTotal")]),
    ).toEqual({
      pairs: [],
      remainingBase: ["ts:src/mail.ts#sendWelcomeEmail"],
      remainingHead: ["ts:src/invoice.ts#renderInvoiceTotal"],
    })
  })

  it("DF19h: covers a body that is only shape: one `for` loop, or one `try`", () => {
    for (const shape of [rule({ type: "loop", loopKind: "for" }), rule({ type: "try" })]) {
      const base = symbolAt("src/mail.ts", "sendAllEmails", "function", [shape])
      const head = symbolAt("src/invoice.ts", "renderInvoiceRows", "function", [shape])
      expect(base.fingerprint.logic).toBe(head.fingerprint.logic)
      expect(stage3([base], [head]).pairs).toEqual([])
    }
  })

  it("DF19: leaves two unrelated top-level `main`s apart", () => {
    expect(stage3([at("src/tool-a.ts", "main")], [at("src/tool-b.ts", "main")])).toEqual({
      pairs: [],
      remainingBase: ["ts:src/tool-a.ts#main"],
      remainingHead: ["ts:src/tool-b.ts#main"],
    })
  })

  it("DF19g: pairs a class whose name says two words when it moves file", () => {
    const base = at("src/old.ts", "InvoiceRenderer", "class")
    const head = at("src/new.ts", "InvoiceRenderer", "class")
    expect(stage3([base], [head])).toEqual({
      pairs: [[base.id, head.id, "logic-fingerprint+name-disambiguation"]],
      remainingBase: [],
      remainingHead: [],
    })
  })

  it("DF19g: leaves a class whose name says one word apart, while its method pairs", () => {
    // The owner and its member are paired independently; nothing reconciles them.
    const oldMethod = at("src/old.ts", "Invoice.render", "method")
    const newMethod = at("src/new.ts", "Invoice.render", "method")
    const result = stage3(
      [at("src/old.ts", "Invoice", "class"), oldMethod],
      [at("src/new.ts", "Invoice", "class"), newMethod],
    )
    expect(result).toEqual({
      pairs: [[oldMethod.id, newMethod.id, "logic-fingerprint+name-disambiguation"]],
      remainingBase: ["ts:src/old.ts#Invoice"],
      remainingHead: ["ts:src/new.ts#Invoice"],
    })
  })

  it("keeps the kind apart on its own: a function and a class of one admissible name", () => {
    // Both names say two words and are identical, so the kind is the only thing refusing this.
    expect(
      stage3(
        [at("src/a.ts", "InvoiceRenderer", "function")],
        [at("src/b.ts", "InvoiceRenderer", "class")],
      ),
    ).toEqual({
      pairs: [],
      remainingBase: ["ts:src/a.ts#InvoiceRenderer"],
      remainingHead: ["ts:src/b.ts#InvoiceRenderer"],
    })
  })

  it("holds the 0.85 bar: 6/7 of a name pairs, 5/6 does not", () => {
    const base = at("src/a.ts", "fetchUserAccountBillingInvoiceTotal")
    expect(
      stage3([base], [at("src/b.ts", "fetchUserAccountBillingInvoiceTotalAmount")]).pairs,
    ).toEqual([
      [
        base.id,
        "ts:src/b.ts#fetchUserAccountBillingInvoiceTotalAmount",
        "logic-fingerprint+name-disambiguation",
      ],
    ])
    expect(stage3([base], [at("src/b.ts", "fetchUserAccountBillingInvoice")]).pairs).toEqual([])
  })

  it("refuses a pair below the bar whether or not its base was the last one left", () => {
    const moved = at("src/a.ts", "parseAmount")
    const renamed = at("src/b.ts", "parseAmountValue")
    const unrelated = at("src/audit.ts", "flushAuditLog")
    expect(stage3([moved], [renamed]).pairs).toEqual([])
    expect(stage3([moved, unrelated], [renamed]).pairs).toEqual([])
  })

  it("does not fall back to the lone-base branch after a scored round", () => {
    const before = at("src/a.ts", "createOrderEntry")
    const after = at("src/b.ts", "createOrderEntry")
    const result = stage3(
      [before, at("src/mail.ts", "sendWelcomeEmail")],
      [after, at("src/invoice.ts", "renderInvoiceTotal")],
    )
    expect(result).toEqual({
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
    const afterStage4 = matchStageNameSignature(
      afterStage3.remainingBase,
      afterStage3.remainingHead,
    )
    expect(afterStage4.matched).toEqual([])
  })
})

describe("matchStageLogicFingerprint — kind", () => {
  const body = (id: string, kind: IRSymbol["kind"], over: Partial<IRSymbol> = {}) => {
    const name = id.slice(id.indexOf("#") + 1)
    return makeSymbol({
      id,
      name,
      kind,
      fingerprint: fp("shared"),
      rules: guardedBody("total > 0"),
      ...over,
    })
  }

  it("never pairs across kinds, even on a shared logic fingerprint that names something", () => {
    const b = body("ts:a.ts#Foo", "function")
    const h = body("ts:b.ts#Foo", "class")
    expect(matchStageLogicFingerprint([b], [h]).matched).toEqual([])
  })

  it("gives up a method extracted into a function, which stage 4 does not take either", () => {
    const base = body("ts:src/a.ts#Cart.computeTotal", "method", { signature: sig() })
    const head = body("ts:src/b.ts#computeTotal", "function", { signature: sig() })
    const afterStage3 = matchStageLogicFingerprint([base], [head])
    expect(afterStage3.matched).toEqual([])
    expect(
      matchStageNameSignature(afterStage3.remainingBase, afterStage3.remainingHead).matched,
    ).toEqual([])
  })

  it("gives up an enum rewritten as a `const` in another file, which stage 4 does not read", () => {
    // In the same file the id survives and stage 1 pairs them; moved, nothing does.
    const base = makeSymbol({ id: "ts:src/a.ts#OrderStatus", name: "OrderStatus", kind: "enum" })
    const head = makeSymbol({ id: "ts:src/b.ts#OrderStatus", name: "OrderStatus", kind: "const" })
    const afterStage3 = matchStageLogicFingerprint([base], [head])
    expect(afterStage3.matched).toEqual([])
    expect(
      matchStageNameSignature(afterStage3.remainingBase, afterStage3.remainingHead).matched,
    ).toEqual([])
  })
})

describe("matchStageNameSignature", () => {
  it("pairs one that reaches the floor exactly", () => {
    const b = makeSymbol({ id: "ts:src/a.ts#UserRepo.get", name: "UserRepo.get", signature: sig() })
    const h = makeSymbol({ id: "ts:src/b.ts#UserRepo.get", name: "UserRepo.get", signature: sig() })
    const result = matchStageNameSignature([b], [h])
    expect(result.matched.map((pair) => `${pair.base.id} -> ${pair.head.id}`)).toEqual([
      "ts:src/a.ts#UserRepo.get -> ts:src/b.ts#UserRepo.get",
    ])
  })

  it("skips pairing when both sides are signatureless (interface / type)", () => {
    const b = makeSymbol({ id: "ts:a.ts#Foo", name: "Foo", kind: "interface" })
    const h = makeSymbol({ id: "ts:a.ts#Foo2", name: "Foo2", kind: "interface" })
    const result = matchStageNameSignature([b], [h])
    expect(result.matched).toEqual([])
  })
})
