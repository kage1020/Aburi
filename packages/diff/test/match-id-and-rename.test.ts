import { fp, makeSymbol } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { matchStageGitRename, matchStageId } from "../src"
import { changesBetween } from "./helpers"

describe("matchStageId", () => {
  it("pairs Symbols of one id and hands on the rest", () => {
    const shared = makeSymbol({ id: "ts:a.ts#Foo", name: "Foo" })
    const baseOnly = makeSymbol({ id: "ts:a.ts#Bar", name: "Bar" })
    const headOnly = makeSymbol({ id: "ts:a.ts#Baz", name: "Baz" })
    const result = matchStageId([shared, baseOnly], [shared, headOnly])
    expect(result.matched).toEqual([{ base: shared, head: shared, rationale: "id-match" }])
    expect(result.remainingBase).toEqual([baseOnly])
    expect(result.remainingHead).toEqual([headOnly])
  })
})

describe("matchStageGitRename", () => {
  const RENAMED = new Map([["src/old.ts", "src/new.ts"]])

  it("pairs a Symbol whose file git renamed", () => {
    const base = makeSymbol({ id: "ts:src/old.ts#Foo", name: "Foo" })
    const head = makeSymbol({ id: "ts:src/new.ts#Foo", name: "Foo" })
    const result = matchStageGitRename([base], [head], RENAMED)
    expect(result.matched).toEqual([{ base, head, rationale: "git-rename" }])
    expect(result.remainingBase).toEqual([])
    expect(result.remainingHead).toEqual([])
  })

  it("pairs a private member, whose qualified name carries a `#` of its own", () => {
    const base = makeSymbol({ id: "ts:src/old.ts#C.#v", name: "C.#v" })
    const head = makeSymbol({ id: "ts:src/new.ts#C.#v", name: "C.#v" })
    expect(matchStageGitRename([base], [head], RENAMED).matched).toEqual([
      { base, head, rationale: "git-rename" },
    ])
  })

  it.each([
    ["no rename map", null],
    ["an empty rename map", new Map<string, string>()],
  ])("hands everything on, in order, given %s", (_, renames) => {
    const base = [
      makeSymbol({ id: "ts:src/old.ts#Foo", name: "Foo" }),
      makeSymbol({ id: "ts:src/a.ts#Bar", name: "Bar" }),
    ]
    const head = [
      makeSymbol({ id: "ts:src/new.ts#Foo", name: "Foo" }),
      makeSymbol({ id: "ts:src/a.ts#Baz", name: "Baz" }),
    ]
    expect(matchStageGitRename(base, head, renames)).toEqual({
      matched: [],
      remainingBase: base,
      remainingHead: head,
    })
  })

  it("leaves a base whose predicted id the id grammar cannot express", () => {
    const base = makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("a") })
    const head = makeSymbol({ id: "ts:src/b.ts#foo", name: "foo", fingerprint: fp("b") })
    expect(matchStageGitRename([base], [head], new Map([["src/a.ts", "..\\out\\b.ts"]]))).toEqual({
      matched: [],
      remainingBase: [base],
      remainingHead: [head],
    })
  })

  it("settles two files renamed onto one target on the lower base id, whichever is written first", () => {
    const at = (file: string, seed: string) =>
      makeSymbol({ id: `ts:${file}#foo`, name: "foo", fingerprint: fp(seed) })
    const gitRenames = new Map([
      ["src/aaa.ts", "src/c.ts"],
      ["src/zzz.ts", "src/c.ts"],
    ])
    const head = [at("src/c.ts", "c")]
    const expected = [
      "moved+changed ts:src/aaa.ts#foo -> ts:src/c.ts#foo",
      "removed ts:src/zzz.ts#foo",
    ]
    expect(
      changesBetween([at("src/aaa.ts", "a"), at("src/zzz.ts", "z")], head, { gitRenames }),
    ).toEqual(expected)
    expect(
      changesBetween([at("src/zzz.ts", "z"), at("src/aaa.ts", "a")], head, { gitRenames }),
    ).toEqual(expected)
  })
})
