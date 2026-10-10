import { fp, makeSymbol, sig } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { matchStageNameSignature } from "../src"
import { changesBetween, method, stagePairNames } from "./helpers"

function stage4(base: readonly IRSymbol[], head: readonly IRSymbol[]): string[] {
  return stagePairNames(matchStageNameSignature(base, head).matched)
}

const withInput = (type: string, throws: string[] = []) =>
  sig({ inputs: [{ name: "id", type }], outputs: ["User"], throws })

describe("stage 4 settles candidates in score order", () => {
  it("pairs an exact match rather than letting an earlier head consume it", () => {
    expect(
      changesBetween(
        [
          method("src/r.ts", "Repo.findUserById", "a"),
          method("src/r.ts", "Repo.findUserByEmailAddress", "b"),
        ],
        [
          method("src/q.ts", "Repo.findUserByEmail", "c"),
          method("src/q.ts", "Repo.findUserByEmailAddress", "d"),
        ],
      ),
    ).toEqual([
      "added ts:src/q.ts#Repo.findUserByEmail",
      "moved+changed ts:src/r.ts#Repo.findUserByEmailAddress -> ts:src/q.ts#Repo.findUserByEmailAddress",
      "removed ts:src/r.ts#Repo.findUserById",
    ])
  })

  it("prefers the higher score over the lower id", () => {
    expect(
      changesBetween(
        [
          method("src/aaa.ts", "Alpha.createInvoiceRecord", "p"),
          method("src/zzz.ts", "Alpha.createOrderRecord", "q"),
        ],
        [method("src/mid.ts", "Alpha.createOrderRecord", "z")],
      ),
    ).toEqual([
      "moved+changed ts:src/zzz.ts#Alpha.createOrderRecord -> ts:src/mid.ts#Alpha.createOrderRecord",
      "removed ts:src/aaa.ts#Alpha.createInvoiceRecord",
    ])
  })

  it.each([
    [
      "base",
      [
        method("src/aaa.ts", "Alpha.createOrderRecord", "p"),
        method("src/zzz.ts", "Alpha.createOrderRecord", "q"),
      ],
      [method("src/mid.ts", "Alpha.createOrderRecord", "z")],
      [
        "moved+changed ts:src/aaa.ts#Alpha.createOrderRecord -> ts:src/mid.ts#Alpha.createOrderRecord",
        "removed ts:src/zzz.ts#Alpha.createOrderRecord",
      ],
    ],
    [
      "head",
      [method("src/mid.ts", "Alpha.createOrderRecord", "z")],
      [
        method("src/aaa.ts", "Alpha.createOrderRecord", "p"),
        method("src/zzz.ts", "Alpha.createOrderRecord", "q"),
      ],
      [
        "added ts:src/zzz.ts#Alpha.createOrderRecord",
        "moved+changed ts:src/mid.ts#Alpha.createOrderRecord -> ts:src/aaa.ts#Alpha.createOrderRecord",
      ],
    ],
  ])("settles a tie on the lower %s id, whichever way the arrays are written", (_, base, head, expected) => {
    expect(changesBetween(base, head)).toEqual(expected)
    expect(changesBetween([...base].reverse(), [...head].reverse())).toEqual(expected)
  })

  it("refuses a pair without signatures, whose signature axis would score a free 1.0", () => {
    const noSignature = (file: string, seed: string) =>
      makeSymbol({
        id: `ts:${file}#OrderService`,
        name: "OrderService",
        kind: "class",
        fingerprint: fp(seed),
      })
    expect(stage4([noSignature("src/a.ts", "a")], [noSignature("src/b.ts", "b")])).toEqual([])
  })
})

describe("the score a pair must reach rises as the head's member name gets shorter", () => {
  it.each([
    [
      "a one-token member with an identical signature",
      method("src/a.ts", "UserRepo.get", "a"),
      method("src/b.ts", "UserRepo.get", "b"),
    ],
    [
      "a two-token member that gained a second throws",
      method("src/a.ts", "UserRepo.getUser", "a", {
        signature: withInput("string", ["AuthError"]),
      }),
      method("src/b.ts", "UserRepo.getUser", "b", {
        signature: withInput("string", ["AuthError", "RateLimitError"]),
      }),
    ],
    [
      "a three-token member that gained its first throws",
      method("src/a.ts", "Service.loadConfigFile", "a"),
      method("src/b.ts", "Service.loadConfigFile", "b", {
        signature: withInput("string", ["AuthError"]),
      }),
    ],
  ])("pairs %s", (_, base, head) => {
    expect(stage4([base], [head])).toEqual([`${base.name} -> ${head.name}`])
  })

  it.each([
    [
      "a one-token member whose input changed type",
      method("src/a.ts", "UserRepo.get", "a"),
      method("src/b.ts", "UserRepo.get", "b", { signature: withInput("number") }),
    ],
    [
      "a two-token member whose input changed type",
      method("src/a.ts", "UserRepo.getUser", "a"),
      method("src/b.ts", "UserRepo.getUser", "b", { signature: withInput("number") }),
    ],
    [
      "a two-token member that turned plural",
      method("src/a.ts", "UserRepo.getUser", "a"),
      method("src/b.ts", "UserRepo.getUsers", "b"),
    ],
  ])("refuses %s", (_, base, head) => {
    expect(stage4([base], [head])).toEqual([])
  })
})

describe("stage 4 reads only the bases that share a member token with the head", () => {
  /** Bases sharing no member token with anything else, to make a bucket too wide to scan whole. */
  const filler = (count: number): IRSymbol[] =>
    Array.from({ length: count }, (_, i) => method(`src/f${i}.ts`, `Repo.zeta${i}Alpha`, `f${i}`))

  it("pairs across a directory rename, where the member name is all that is shared", () => {
    expect(
      stage4(
        [method("src/old/a.ts", "Service.handleRequest", "a")],
        [method("src/new/a.ts", "Service.handleRequest", "b")],
      ),
    ).toEqual(["Service.handleRequest -> Service.handleRequest"])
  })

  it.each([
    [
      "a renamed member below the member-similarity floor",
      "Repo.loadConfigFile",
      "Repo.loadConfigFiles",
    ],
    ["two members with no token in common", "UserRepo.save", "UserRepo.delete"],
    ["two members whose one shared token is not enough", "Repo.getUser", "Repo.getInvoice"],
  ])("refuses %s", (_, baseName, headName) => {
    expect(
      stage4([method("src/a.ts", baseName, "a")], [method("src/a.ts", headName, "b")]),
    ).toEqual([])
  })

  it("pairs two Symbols whose member name has no tokens, and nothing else with them", () => {
    const empty = (file: string, seed: string) => method(file, "Foo.Bar.", seed)
    expect(stage4([empty("src/a.ts", "a")], [empty("src/b.ts", "b")])).toEqual([
      "Foo.Bar. -> Foo.Bar.",
    ])
    expect(stage4([empty("src/a.ts", "a")], [method("src/b.ts", "Foo.handle", "b")])).toEqual([])
  })

  it.each([
    [
      "the base's shared tokens exclude its first",
      "Repo.loadConfigFileAsync",
      "Repo.configFileAsync",
    ],
    [
      "the head's shared tokens exclude its first",
      "Repo.configFileAsync",
      "Repo.loadConfigFileAsync",
    ],
  ])("reaches a base through the index when %s", (_, baseName, headName) => {
    expect(
      stage4(
        [...filler(8), method("src/a.ts", baseName, "a")],
        [method("src/b.ts", headName, "b")],
      ),
    ).toEqual([`${baseName} -> ${headName}`])
  })

  it("keeps several heads apart through one bucket", () => {
    const base = [
      ...filler(8),
      method("src/a1.ts", "Repo.loadConfigFile", "a1"),
      method("src/a2.ts", "Repo.parseHeaderValue", "a2"),
    ]
    const head = [
      method("src/b1.ts", "Repo.loadConfigFile", "b1"),
      method("src/b2.ts", "Repo.parseHeaderValue", "b2"),
    ]
    expect(stage4(base, head).sort()).toEqual([
      "Repo.loadConfigFile -> Repo.loadConfigFile",
      "Repo.parseHeaderValue -> Repo.parseHeaderValue",
    ])
  })

  it.each([
    [
      "the index narrows the bucket",
      12,
      ["loadConfigFile", "saveConfigFile", "resetConfigFile", "watchConfigFile"],
    ],
    [
      "every head reaches the whole bucket",
      0,
      ["loadConfig", "saveConfig", "resetConfig", "watchConfig"],
    ],
  ])("pairs every method of a renamed directory when %s", (_, fillers, members) => {
    const base = [
      ...filler(fillers),
      ...members.map((m, i) => method(`src/old/m${i}.ts`, `Store.${m}`, `a${i}`)),
    ]
    const head = members.map((m, i) => method(`src/new/m${i}.ts`, `Store.${m}`, `b${i}`))
    expect(stage4(base, head).sort()).toEqual(members.map((m) => `Store.${m} -> Store.${m}`).sort())
  })
})
