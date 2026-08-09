import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, matchStageLogicFingerprint } from "../src"
import { nameSimilarity, ownersAreCompatible } from "../src/similarity"
import { fp, makeIR, makeSymbol, sig } from "./fixtures"

/**
 * §3.4.6 (R-8) exists to keep `UserRepo.getUser` from pairing with `AdminRepo.getUser` while
 * letting it pair with `UsersRepository.getUser` — the same method after its class was
 * renamed. It could do neither, for two reasons that compounded.
 *
 * The owner was counted twice. §3.4.1's name axis is a Jaccard over the *whole* qualified
 * name, so a renamed owner depressed the name term, and §3.4.6 then charged for it again at
 * 0.2. `UserRepo.getUser` vs `UsersRepository.getUser` scored 0.5 where §3.4.6's arithmetic
 * assumed 0.9, and the class rename came out as `added` + `removed`.
 *
 * And the owner was a weight, which cannot do the job R-8 describes. Grading owners means a
 * perfect member name and signature can outvote a mismatched class: at weight 0.2 two classes
 * sharing one token of two reach 0.8667, and three sharing two reach 0.90. No threshold
 * refuses those without also refusing the renames — the pair R-8 must reject outscores the
 * pair it must accept, because `AdminRepo` shares a token with `UserRepo` and
 * `UsersRepository` shares none — and raising the weight to 0.3 only brings the three-token
 * collision down to exactly 0.85, which still passes.
 *
 * So the owner is a **gate**: two owned Symbols may pair only if their owners are the same
 * class or a rename of it. Past the gate there is no owner left to grade, and the name axis
 * reads the last segment — the member — which is what removes the double count.
 */

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
  // §3.4.6's original headline example, and the price of refusing the collisions below. A
  // prefix rule accepts `repo` -> `repository`, and with it `repo` -> `report`: two distinct
  // classes, which is the collision R-8 exists to refuse. Nothing over the two strings alone
  // separates them — the renames score *lower* than the collisions on every measure tried —
  // so the gate declines the whole family rather than guessing.

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
  // `tokenizeName` dedups, and an owner that repeats a word across its segments loses a token
  // to it: `Users.UserRepo` collapses to {users, user, repo} where `Users.UserRepos` collapses
  // to {users, user, repos}. Comparing whole owners made the sizes disagree before any
  // spelling was looked at, and the rename came back as added + removed.
  it("pairs a namespaced class whose namespace shares a word with it", () => {
    // Whole-owner tokens are {users, user, repo} against {users, repo}: the head's namespace
    // and its renamed class collapse into one token, the sizes stop matching, and the rename is
    // refused before any spelling is compared. Per segment they line up.
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
    // A nested class is not the namespace it sits under, though every segment of the shorter
    // owner has a counterpart in the longer and the token multiset covers it.
    expect(renamed("Users.Repo", "Users.Repo.Inner", "getUser")).toEqual([])
  })
})

describe("the end-to-end refactor the section is for", () => {
  it("reports a renamed class of three edited methods as moved+changed, not added and removed", () => {
    // `moved` because the qualified name is part of the id, so a rename relocates the Symbol
    // whether or not its file did — §4's `pathChanged`, and DF9.
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
    // The case that defeats grading: two of three owner tokens shared scores 0.90 at weight
    // 0.2, and exactly 0.85 — still passing — at 0.3, so raising the weight does not close it.
    // A gate does not ask how much of the name matched.
    expect(renamed("UserRepoService", "AdminRepoService", "findById")).toEqual([])
  })

  it("refuses an extra token rather than reading it as a rename", () => {
    // `UserRepoV2` alongside `UserRepo` is as likely a second class as a renamed one, and
    // R-8's business is refusing the collision.
    expect(renamed("UserRepo", "UserRepoV2", "getUser")).toEqual([])
  })

  it("refuses a stem too short to be evidence", () => {
    // `id` is two characters, and a two-character prefix matches far too much to be a rename
    // signal. `IdMap` -> `IdentityMap` is a real rename this declines to guess at.
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
    // Every token under the old three-character floor, so an equality test was all that held
    // these together — and dropping it took every method of the class with it.
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
})

describe("what the gate does not change", () => {
  it("leaves the name axis full-qualified for stage 3", () => {
    // Stage 3 disambiguates within one logic-fingerprint group and has no owner term, so the
    // whole name is the right comparison there. Two same-logic methods of different classes
    // pair on it — a gate here would be a different rule, not this one.
    const shared = fp("same")
    const base = makeSymbol({
      id: "ts:src/a.ts#UserRepo.getUser",
      name: "UserRepo.getUser",
      kind: "method",
      fingerprint: shared,
      signature: GET_BY_ID,
    })
    const head = makeSymbol({
      id: "ts:src/b.ts#UsersRepository.getUser",
      name: "UsersRepository.getUser",
      kind: "method",
      fingerprint: shared,
      signature: GET_BY_ID,
    })
    const result = matchStageLogicFingerprint([base], [head])
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.rationale).toBe("logic-fingerprint")
    expect(nameSimilarity("UserRepo.getUser", "UsersRepository.getUser")).toBeCloseTo(0.4, 5)
  })

  it("still refuses `getUser` against `getUsers` under one owner", () => {
    // The threshold table's reason for existing. Past the gate the member names are all that
    // is left, and these two share one token of three.
    expect(
      pairs(
        [method("src/a.ts", "UserRepo.getUser", "aaa")],
        [method("src/a.ts", "UserRepo.getUsers", "bbb")],
      ),
    ).toEqual([])
  })
})
