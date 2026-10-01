import { EMPTY_LOGIC_FINGERPRINT } from "@aburi/core"
import { fp, makeSymbol, sig, zeroFp } from "@aburi/test-support"
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
    const b = makeSymbol({ id: "ts:a.ts#Foo", name: "Foo", fingerprint: shared })
    const h = makeSymbol({ id: "ts:a.ts#Bar", name: "Bar", fingerprint: shared })
    const result = matchStageLogicFingerprint([b], [h])
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.rationale).toBe("logic-fingerprint")
  })

  it("uses name similarity to disambiguate multi-candidate buckets", () => {
    const shared = fp("shared")
    // Two base symbols share the same logic fingerprint (workspace duplication of
    // logic body across a helper and an alias, for example).
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
    // Head is the same qualified name as winner but relocated to a new file; the id is
    // different (path-part of id differs) so it falls through to stage 3, where the
    // multi-candidate branch fires and name similarity 1.0 vs winner selects it.
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

/**
 * Every Symbol with no rules and no effects carries one logic fingerprint, so sharing it says
 * nothing about meaning. Its group pairs only on a name that says more than one word and
 * reaches the 0.85 bar, and never across kinds.
 */
describe("matchStageLogicFingerprint — the empty logic axis", () => {
  const emptyLogic = { ...fp("empty"), logic: EMPTY_LOGIC_FINGERPRINT }
  const at = (file: string, name: string, kind: IRSymbol["kind"] = "function") =>
    makeSymbol({
      id: `ts:${file}#${name}`,
      name,
      kind,
      fingerprint: emptyLogic,
      source: { file, startLine: 1, endLine: 3, startColumn: null, endColumn: null },
    })

  it("DF19f: does not pair a lone deleted function with an unrelated class", () => {
    const result = matchStageLogicFingerprint(
      [at("src/mail.ts", "sendWelcomeEmail")],
      [at("src/invoice.ts", "InvoiceRenderer", "class")],
    )
    expect(result.matched).toEqual([])
  })

  it("does not pair it with an unrelated function either (no lone-base shortcut)", () => {
    const result = matchStageLogicFingerprint(
      [at("src/mail.ts", "sendWelcomeEmail")],
      [at("src/invoice.ts", "renderInvoiceTotal")],
    )
    expect(result.matched).toEqual([])
  })

  it("DF19: leaves two unrelated top-level `main`s apart", () => {
    const result = matchStageLogicFingerprint(
      [at("src/tool-a.ts", "main")],
      [at("src/tool-b.ts", "main")],
    )
    expect(result.matched).toEqual([])
  })

  it("DF19g: pairs a class of a name that says two words when it moves file", () => {
    const base = at("src/old.ts", "InvoiceRenderer", "class")
    const head = at("src/new.ts", "InvoiceRenderer", "class")
    const result = matchStageLogicFingerprint([base], [head])
    expect(result.matched.map((pair) => [pair.base.id, pair.head.id, pair.rationale])).toEqual([
      [base.id, head.id, "logic-fingerprint+name-disambiguation"],
    ])
  })

  it("gives the same answer however many other empty-logic Symbols were deleted", () => {
    const moved = at("src/a.ts", "parseAmount")
    const renamed = at("src/b.ts", "parseAmountValue")
    const unrelated = at("src/audit.ts", "flushAuditLog")
    const alone = matchStageLogicFingerprint([moved], [renamed])
    const withOther = matchStageLogicFingerprint([moved, unrelated], [renamed])
    expect(alone.matched).toEqual([])
    expect(withOther.matched).toEqual([])
  })
})

describe("matchStageLogicFingerprint — kind", () => {
  it("never pairs across kinds, even on a shared non-empty logic fingerprint", () => {
    const shared = fp("shared")
    const b = makeSymbol({ id: "ts:a.ts#Foo", name: "Foo", kind: "function", fingerprint: shared })
    const h = makeSymbol({ id: "ts:b.ts#Foo", name: "Foo", kind: "class", fingerprint: shared })
    expect(matchStageLogicFingerprint([b], [h]).matched).toEqual([])
  })
})

describe("matchStageNameSignature", () => {
  it("pairs one that reaches the floor exactly", () => {
    // 1.0 is the top of the scale and a reachable score: an identical name, signature and
    // owner give `0.5 + 0.3 + 0.2`, exactly 1 in IEEE 754. `score >= threshold` is what lets
    // this row pair at all — a `>` would empty it.
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
