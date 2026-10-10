import { fp, guardedBody, makeIR, makeSymbol, sig } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, matchStageLogicFingerprint } from "../src"
import { nameSimilarity, ownersAreCompatible } from "../src/similarity"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

const GET_BY_ID = sig({ inputs: [{ name: "id", type: "string" }], outputs: ["User"] })

function method(file: string, name: string, body: string): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind: "method",
    signature: GET_BY_ID,
    fingerprint: fp(body),
    source: { file, startLine: 1, endLine: 2 },
  })
}

function topLevel(file: string, name: string, body: string): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    signature: GET_BY_ID,
    fingerprint: fp(body),
    source: { file, startLine: 1, endLine: 2 },
  })
}

function pairs(base: IRSymbol[], head: IRSymbol[]): string[] {
  const diff = buildDiff({
    baseIR: makeIR({ symbols: base }),
    headIR: makeIR({ symbols: head }),
    base: IR_REF,
    head: IR_REF,
  })
  return diff.symbols.flatMap((change) =>
    "before" in change && "after" in change
      ? [`${change.before.name} -> ${change.after.name}`]
      : [],
  )
}

/** One method a side, class renamed between them, body edited so only stage 4 can pair it. */
function renamed(baseOwner: string, headOwner: string, member: string): string[] {
  return pairs(
    [method("src/repo.ts", `${baseOwner}.${member}`, "aaa")],
    [method("src/repo.ts", `${headOwner}.${member}`, "bbb")],
  )
}

describe("a class renamed by inflection keeps its methods", () => {
  it("pairs a method whose class was pluralised", () => {
    expect(renamed("UserRepo", "UserRepos", "getUser")).toEqual([
      "UserRepo.getUser -> UserRepos.getUser",
    ])
  })

  it("pairs one whose method name has three tokens", () => {
    // The other threshold row: `findById` is 3 tokens, so 0.85 governs rather than 0.95.
    expect(renamed("UserRepo", "UserRepos", "findById")).toEqual([
      "UserRepo.findById -> UserRepos.findById",
    ])
  })

  it("reads the `y` -> `ies` form too", () => {
    expect(renamed("EntityStore", "EntitiesStore", "findById")).toEqual([
      "EntityStore.findById -> EntitiesStore.findById",
    ])
  })

  it("keeps a same-named method of a different class apart", () => {
    expect(renamed("UserRepo", "AdminRepo", "getUser")).toEqual([])
  })
})

describe("an abbreviation is not read as a rename", () => {
  it("declines UserRepo -> UsersRepository", () => {
    expect(renamed("UserRepo", "UsersRepository", "findById")).toEqual([])
  })

  it("refuses the collisions that come with accepting it", () => {
    expect(renamed("RepoManager", "ReportManager", "loadConfigFile")).toEqual([])
    expect(renamed("CacheStore", "CachedStore", "readEntryByKey")).toEqual([])
    expect(renamed("ConManager", "ControllerManager", "loadConfigFile")).toEqual([])
    expect(renamed("OrderService", "OrderingService", "processPendingBatch")).toEqual([])
  })
})

describe("an owner is a path, compared segment by segment", () => {
  it("pairs a namespaced class whose namespace shares a word with it", () => {
    expect(renamed("Users.UserRepo", "Users.UsersRepo", "getUser")).toEqual([
      "Users.UserRepo.getUser -> Users.UsersRepo.getUser",
    ])
  })

  it("pairs one whose class is pluralised under a namespace", () => {
    expect(renamed("Users.UserRepo", "Users.UserRepos", "getUser")).toEqual([
      "Users.UserRepo.getUser -> Users.UserRepos.getUser",
    ])
  })

  it("pairs one nested two deep", () => {
    expect(renamed("App.Services.UserRepo", "App.Services.UserRepos", "getUser")).toEqual([
      "App.Services.UserRepo.getUser -> App.Services.UserRepos.getUser",
    ])
  })

  it("keeps the namespace itself under the same rule", () => {
    expect(renamed("Billing.Store", "Shipping.Store", "findById")).toEqual([])
  })

  it("reads a differing depth as a differing scope", () => {
    expect(renamed("Services.UserRepo", "UserRepo", "getUser")).toEqual([])
    expect(renamed("Users.Repo", "Users.Repo.Inner", "getUser")).toEqual([])
  })
})

describe("the end-to-end refactor the section is for", () => {
  it("reports a renamed class of three edited methods as moved+changed, not added and removed", () => {
    const members = ["getUser", "findById", "save"]
    const diff = buildDiff({
      baseIR: makeIR({
        symbols: members.map((m) => method("src/repo.ts", `UserRepo.${m}`, `a${m}`)),
      }),
      headIR: makeIR({
        symbols: members.map((m) => method("src/repo.ts", `UserRepos.${m}`, `b${m}`)),
      }),
      base: IR_REF,
      head: IR_REF,
    })
    expect(diff.summary.movedChanged).toBe(3)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.removed).toBe(0)
  })

  it("moves them too when the file moved with the class", () => {
    expect(
      pairs(
        [method("src/user-repo.ts", "UserRepo.getUser", "aaa")],
        [method("src/user-repos.ts", "UserRepos.getUser", "bbb")],
      ),
    ).toEqual(["UserRepo.getUser -> UserRepos.getUser"])
  })
})

describe("the gate refuses what a weighted owner could not", () => {
  it("refuses two classes that share two tokens of three", () => {
    expect(renamed("UserRepoService", "AdminRepoService", "findById")).toEqual([])
  })

  it("refuses an extra token rather than reading it as a rename", () => {
    expect(renamed("UserRepo", "UserRepoV2", "getUser")).toEqual([])
  })

  it("refuses a stem too short to be evidence", () => {
    expect(renamed("IdMap", "IdentityMap", "findById")).toEqual([])
  })

  it("does not pair a method with a top-level function of the same name", () => {
    expect(
      pairs(
        [topLevel("src/a.ts", "findById", "aaa")],
        [method("src/a.ts", "UserRepo.findById", "bbb")],
      ),
    ).toEqual([])
  })

  it("still pairs two top-level functions, which share the empty owner", () => {
    expect(
      pairs(
        [topLevel("src/a.ts", "findUserById", "aaa")],
        [topLevel("src/b.ts", "findUserById", "bbb")],
      ),
    ).toEqual(["findUserById -> findUserById"])
  })
})

describe("ownersAreCompatible", () => {
  it("accepts an inflection in either direction", () => {
    expect(ownersAreCompatible("UserRepo.x", "UserRepos.x")).toBe(true)
    expect(ownersAreCompatible("UserRepos.x", "UserRepo.x")).toBe(true)
  })

  it("holds a prefix that is not an inflection apart", () => {
    // The property the whole rule turns on: `startsWith` would make these one class.
    expect(ownersAreCompatible("UserRepo.x", "SuperuserRepo.x")).toBe(false)
    expect(ownersAreCompatible("RepoManager.x", "ReportManager.x")).toBe(false)
    expect(ownersAreCompatible("CacheStore.x", "CachedStore.x")).toBe(false)
  })

  it("keeps a class of short tokens compatible with itself", () => {
    expect(ownersAreCompatible("IO.read", "IO.write")).toBe(true)
    expect(ownersAreCompatible("Db.get", "Db.put")).toBe(true)
  })

  it("accepts the same owner, and the shared empty owner", () => {
    expect(ownersAreCompatible("UserRepo.x", "UserRepo.x")).toBe(true)
    expect(ownersAreCompatible("x", "y")).toBe(true)
  })

  it("declines an abbreviation", () => {
    expect(ownersAreCompatible("UserRepo.x", "UsersRepository.x")).toBe(false)
    expect(ownersAreCompatible("Repo.x", "Repository.x")).toBe(false)
  })

  it("requires every token on both sides to find a partner", () => {
    expect(ownersAreCompatible("UserRepo.x", "AdminRepo.x")).toBe(false)
    expect(ownersAreCompatible("UserRepo.x", "UserRepoV2.x")).toBe(false)
    expect(ownersAreCompatible("OrderService.x", "InvoiceService.x")).toBe(false)
  })

  it("reads `::` owners the same way as dotted ones", () => {
    expect(ownersAreCompatible("UserRepo::create", "UserRepos::create")).toBe(true)
    expect(ownersAreCompatible("UserRepo::create", "AdminRepo::create")).toBe(false)
  })

  it("pairs one empty owner with none", () => {
    expect(ownersAreCompatible("findById", "UserRepo.findById")).toBe(false)
    expect(ownersAreCompatible("UserRepo.findById", "findById")).toBe(false)
  })

  it("finds a matching a greedy pass would strand", () => {
    expect(ownersAreCompatible("UsersUser.x", "UsersUserses.x")).toBe(true)
  })

  it("does not call two owners compatible by displacing without checking", () => {
    expect(ownersAreCompatible("UserUsers.x", "UsersAdmin.x")).toBe(false)
  })

  it("refuses an owner segment with more tokens than the search will take", () => {
    const wide = (last: string) =>
      `${Array.from({ length: 40 }, (_, i) => `Seg${i}`).join("")}${last}.x`
    expect(ownersAreCompatible(wide("Tail"), wide("Tail"))).toBe(true) // equal, short-circuits
    expect(ownersAreCompatible(wide("Tail"), wide("Tails"))).toBe(false)
  })
})

describe("what the gate does not change", () => {
  it("leaves the name axis full-qualified for stage 3", () => {
    const shared = fp("same")
    const base = makeSymbol({
      id: "ts:src/a.ts#UserRepo.getUser",
      name: "UserRepo.getUser",
      kind: "method",
      fingerprint: shared,
      rules: guardedBody("id"),
      signature: GET_BY_ID,
    })
    const head = makeSymbol({
      id: "ts:src/b.ts#UsersRepository.getUser",
      name: "UsersRepository.getUser",
      kind: "method",
      fingerprint: shared,
      rules: guardedBody("id"),
      signature: GET_BY_ID,
    })
    const result = matchStageLogicFingerprint([base], [head])
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.rationale).toBe("logic-fingerprint")
    expect(nameSimilarity("UserRepo.getUser", "UsersRepository.getUser")).toBeCloseTo(0.4, 5)
  })

  it("still refuses `getUser` against `getUsers` under one owner", () => {
    expect(
      pairs(
        [method("src/a.ts", "UserRepo.getUser", "aaa")],
        [method("src/a.ts", "UserRepo.getUsers", "bbb")],
      ),
    ).toEqual([])
  })
})
