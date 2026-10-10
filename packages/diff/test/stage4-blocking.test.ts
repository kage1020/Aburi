import { fp, makeSymbol, sig } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { matchStageNameSignature } from "../src"

const ONE_INPUT = sig({ inputs: [{ name: "id", type: "string" }], outputs: ["User"] })

function method(file: string, name: string, seed: string, signature = ONE_INPUT): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind: "method",
    signature,
    fingerprint: fp(seed),
    source: { file, startLine: 1, endLine: 2 },
  })
}

/** The pairings stage 4 reports, as `base -> head` names. */
function pairs(base: IRSymbol[], head: IRSymbol[]): string[] {
  return matchStageNameSignature(base, head).matched.map((p) => `${p.base.name} -> ${p.head.name}`)
}

describe("a pairing that survives always shares a member token", () => {
  it("pairs across a directory rename, which is what shares nothing else", () => {
    expect(
      pairs(
        [method("src/old/a.ts", "Service.handleRequest", "a")],
        [method("src/new/a.ts", "Service.handleRequest", "b")],
      ),
    ).toEqual(["Service.handleRequest -> Service.handleRequest"])
  })

  it("pairs on the member token even when the signature moved", () => {
    expect(
      pairs(
        [method("src/old/a.ts", "Service.loadConfigFile", "a")],
        [
          method(
            "src/new/a.ts",
            "Service.loadConfigFile",
            "b",
            sig({
              inputs: [{ name: "id", type: "string" }],
              outputs: ["User"],
              throws: ["AuthError"],
            }),
          ),
        ],
      ),
    ).toEqual(["Service.loadConfigFile -> Service.loadConfigFile"])
  })

  it("refuses a renamed member, which the floor already refused", () => {
    expect(
      pairs(
        [method("src/a.ts", "Repo.loadConfigFile", "a")],
        [method("src/a.ts", "Repo.loadConfigFiles", "b")],
      ),
    ).toEqual([])
  })

  it("does not pair two members with no token in common", () => {
    expect(
      pairs(
        [method("src/a.ts", "UserRepo.save", "a")],
        [method("src/a.ts", "UserRepo.delete", "b")],
      ),
    ).toEqual([])
  })

  it("holds the floor where the member axis alone decides", () => {
    expect(
      pairs(
        [method("src/a.ts", "Repo.getUser", "a")],
        [method("src/a.ts", "Repo.getInvoice", "b")],
      ),
    ).toEqual([])
  })
})

describe("a member name with no tokens is indexed too", () => {
  it("pairs two Symbols whose member name is empty", () => {
    expect(
      pairs([method("src/a.ts", "Foo.Bar.", "a")], [method("src/b.ts", "Foo.Bar.", "b")]),
    ).toEqual(["Foo.Bar. -> Foo.Bar."])
  })

  it("keeps them away from Symbols that do carry tokens", () => {
    expect(
      pairs([method("src/a.ts", "Foo.Bar.", "a")], [method("src/b.ts", "Foo.handle", "b")]),
    ).toEqual([])
  })
})

describe("the postings walk finds what the fallback would have", () => {
  /** Bases sharing no member token with anything else, to make a bucket too wide to fall back. */
  const filler = (count: number): IRSymbol[] =>
    Array.from({ length: count }, (_, i) => method(`src/f${i}.ts`, `Repo.zeta${i}Alpha`, `f${i}`))

  it("reaches a base whose shared tokens exclude its first", () => {
    const base = [...filler(8), method("src/a.ts", "Repo.loadConfigFileAsync", "a")]
    const head = [method("src/b.ts", "Repo.configFileAsync", "b")]
    expect(pairs(base, head)).toEqual(["Repo.loadConfigFileAsync -> Repo.configFileAsync"])
  })

  it("reaches a base whose shared tokens exclude the head's first", () => {
    const base = [...filler(8), method("src/a.ts", "Repo.configFileAsync", "a")]
    const head = [method("src/b.ts", "Repo.loadConfigFileAsync", "b")]
    expect(pairs(base, head)).toEqual(["Repo.configFileAsync -> Repo.loadConfigFileAsync"])
  })

  it("keeps several heads apart through one bucket's stamp", () => {
    const base = [
      ...filler(8),
      method("src/a1.ts", "Repo.loadConfigFile", "a1"),
      method("src/a2.ts", "Repo.parseHeaderValue", "a2"),
    ]
    const head = [
      method("src/b1.ts", "Repo.loadConfigFile", "b1"),
      method("src/b2.ts", "Repo.parseHeaderValue", "b2"),
    ]
    expect(pairs(base, head).sort()).toEqual([
      "Repo.loadConfigFile -> Repo.loadConfigFile",
      "Repo.parseHeaderValue -> Repo.parseHeaderValue",
    ])
  })

  it("pairs a bulk rename through the index rather than the fallback", () => {
    // The case the change exists for, padded so the bucket is wider than any head's reach.
    const members = ["loadConfigFile", "saveConfigFile", "resetConfigFile", "watchConfigFile"]
    const base = [
      ...filler(12),
      ...members.map((m, i) => method(`src/old/m${i}.ts`, `Store.${m}`, `a${i}`)),
    ]
    const head = members.map((m, i) => method(`src/new/m${i}.ts`, `Store.${m}`, `b${i}`))
    expect(pairs(base, head).sort()).toEqual(members.map((m) => `Store.${m} -> Store.${m}`).sort())
  })
})

describe("the shortcuts answer as the rule they stand in for", () => {
  it("pairs a namespaced class whose namespace is unchanged", () => {
    expect(
      pairs(
        [method("src/a.ts", "Users.UserRepo.loadConfigFile", "a")],
        [method("src/b.ts", "Users.UserRepos.loadConfigFile", "b")],
      ),
    ).toEqual(["Users.UserRepo.loadConfigFile -> Users.UserRepos.loadConfigFile"])
  })

  it("refuses one whose namespace changed, on the first segment alone", () => {
    expect(
      pairs(
        [method("src/a.ts", "Billing.Store.loadConfigFile", "a")],
        [method("src/b.ts", "Shipping.Store.loadConfigFile", "b")],
      ),
    ).toEqual([])
  })

  it("refuses a first segment carrying an extra token", () => {
    expect(
      pairs(
        [method("src/a.ts", "User.Store.loadConfigFile", "a")],
        [method("src/b.ts", "UserAdmin.Store.loadConfigFile", "b")],
      ),
    ).toEqual([])
  })

  it("refuses a first segment whose token is merely similar", () => {
    expect(
      pairs(
        [method("src/a.ts", "Repo.Store.loadConfigFile", "a")],
        [method("src/b.ts", "Report.Store.loadConfigFile", "b")],
      ),
    ).toEqual([])
  })

  it("pairs two top-level functions, which the identical-owner branch settles", () => {
    const top = (file: string, name: string, seed: string): IRSymbol =>
      makeSymbol({
        id: `ts:${file}#${name}`,
        name,
        signature: ONE_INPUT,
        fingerprint: fp(seed),
        source: { file, startLine: 1, endLine: 2 },
      })
    expect(
      pairs([top("src/a.ts", "loadConfigFile", "a")], [top("src/b.ts", "loadConfigFile", "b")]),
    ).toEqual(["loadConfigFile -> loadConfigFile"])
  })
})

describe("the fallback path answers a bulk rename the same way", () => {
  it("pairs every method of a renamed directory", () => {
    const members = ["loadConfig", "saveConfig", "resetConfig", "watchConfig"]
    const base = members.map((m, i) => method(`src/old/mod${i}.ts`, `Store.${m}`, `a${i}`))
    const head = members.map((m, i) => method(`src/new/mod${i}.ts`, `Store.${m}`, `b${i}`))
    expect(pairs(base, head).sort()).toEqual(members.map((m) => `Store.${m} -> Store.${m}`).sort())
  })

  it("still separates the ones whose owners are unrelated", () => {
    const base = [method("src/a.ts", "UserRepo.handleRequest", "a")]
    const head = [method("src/b.ts", "AdminRepo.handleRequest", "b")]
    expect(pairs(base, head)).toEqual([])
  })
})
