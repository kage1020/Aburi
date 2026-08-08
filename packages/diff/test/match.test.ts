import { describe, expect, it } from "vitest"
import {
  matchStageDroppedWeak,
  matchStageGitRename,
  matchStageId,
  matchStageLogicFingerprint,
  matchStageNameSignature,
} from "../src"
import { fp, makeSymbol, sig, zeroFp } from "./fixtures"

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

describe("matchStageNameSignature", () => {
  it("holds a 1-token name to the 1.0 floor", () => {
    const b = makeSymbol({ id: "ts:a.ts#foo", name: "foo", signature: sig() })
    const h = makeSymbol({ id: "ts:a.ts#foo2", name: "foo2", signature: sig() })
    const result = matchStageNameSignature([b], [h])
    expect(result.matched).toEqual([])
  })

  it("pairs a 1-token name that scores exactly 1.0", () => {
    // 1.0 is reachable, not impossible: identical name, signature and owner give
    // `0.5 + 0.3 + 0.2`, which is exactly 1 in IEEE 754. A top-level `main` moved to another
    // file with an edited body falls out of stage 3 and lands here, and `score >= threshold`
    // is what lets it pair — the case a `>` would silently take away.
    const b = makeSymbol({ id: "ts:src/a.ts#main", name: "main", signature: sig() })
    const h = makeSymbol({ id: "ts:src/b.ts#main", name: "main", signature: sig() })
    const result = matchStageNameSignature([b], [h])
    expect(result.matched.map((pair) => `${pair.base.id} -> ${pair.head.id}`)).toEqual([
      "ts:src/a.ts#main -> ts:src/b.ts#main",
    ])
  })

  it("skips pairing when both sides are signatureless (interface / type)", () => {
    const b = makeSymbol({ id: "ts:a.ts#Foo", name: "Foo", kind: "interface" })
    const h = makeSymbol({ id: "ts:a.ts#Foo2", name: "Foo2", kind: "interface" })
    const result = matchStageNameSignature([b], [h])
    expect(result.matched).toEqual([])
  })
})

describe("matchStageDroppedWeak", () => {
  it("pairs dropped symbols with matching last-segment name (any file)", () => {
    const b = makeSymbol({
      id: "ts:src/old/dto.ts#UserDto",
      name: "UserDto",
      kind: "class",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const h = makeSymbol({
      id: "ts:src/new/dto.ts#UserDto",
      name: "UserDto",
      kind: "class",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const result = matchStageDroppedWeak([b], [h])
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.rationale).toBe("dropped-weak-match")
  })

  it("refuses cross-kind weak pairings", () => {
    const b = makeSymbol({
      id: "ts:src/dto.ts#Foo",
      name: "Foo",
      kind: "interface",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const h = makeSymbol({
      id: "ts:src/dto.ts#Foo",
      name: "Foo",
      kind: "class",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const result = matchStageDroppedWeak([b], [h])
    expect(result.matched).toEqual([])
  })
})
