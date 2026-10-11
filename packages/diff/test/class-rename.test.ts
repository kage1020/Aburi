import { guardedBody } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { matchStageLogicFingerprint, ownersAreCompatible } from "../src"
import { diffSymbols, fn, method, pairedNames } from "./helpers"

/** One method a side, its class renamed between them, body edited so only stage 4 can pair it. */
function renamed(baseOwner: string, headOwner: string, member: string): string[] {
  return pairedNames(
    [method("src/repo.ts", `${baseOwner}.${member}`, "aaa")],
    [method("src/repo.ts", `${headOwner}.${member}`, "bbb")],
  )
}

describe("a method whose class was renamed by inflection", () => {
  it.each([
    ["was pluralised", "UserRepo", "UserRepos", "getUser"],
    ["was pluralised, under the three-token threshold", "UserRepo", "UserRepos", "findById"],
    ["went from `y` to `ies`", "EntityStore", "EntitiesStore", "findById"],
    [
      "is pluralised under a namespace that shares its word",
      "Users.UserRepo",
      "Users.UsersRepo",
      "getUser",
    ],
    ["is pluralised under an unchanged namespace", "Users.UserRepo", "Users.UserRepos", "getUser"],
    [
      "is pluralised two namespaces deep",
      "App.Services.UserRepo",
      "App.Services.UserRepos",
      "getUser",
    ],
  ])("keeps its pairing when the class %s", (_, baseOwner, headOwner, member) => {
    expect(renamed(baseOwner, headOwner, member)).toEqual([
      `${baseOwner}.${member} -> ${headOwner}.${member}`,
    ])
  })

  it("reports every edited method of the class as moved+changed, not added and removed", () => {
    const members = ["getUser", "findById", "save"]
    const diff = diffSymbols(
      members.map((m) => method("src/repo.ts", `UserRepo.${m}`, `a${m}`)),
      members.map((m) => method("src/repo.ts", `UserRepos.${m}`, `b${m}`)),
    )
    expect(diff.summary).toMatchObject({ movedChanged: 3, added: 0, removed: 0 })
  })

  it("keeps its pairing when the file moved with the class", () => {
    expect(
      pairedNames(
        [method("src/user-repo.ts", "UserRepo.getUser", "aaa")],
        [method("src/user-repos.ts", "UserRepos.getUser", "bbb")],
      ),
    ).toEqual(["UserRepo.getUser -> UserRepos.getUser"])
  })
})

describe("a same-named method of a different class", () => {
  it("stays apart from it", () => {
    expect(renamed("UserRepo", "AdminRepo", "getUser")).toEqual([])
  })

  it("stays apart from a top-level function of the same name", () => {
    expect(
      pairedNames(
        [fn("src/a.ts", "findById", "aaa")],
        [method("src/a.ts", "UserRepo.findById", "bbb")],
      ),
    ).toEqual([])
  })

  it("is not what two top-level functions are, which share the empty owner", () => {
    expect(
      pairedNames([fn("src/a.ts", "findUserById", "aaa")], [fn("src/b.ts", "findUserById", "bbb")]),
    ).toEqual(["findUserById -> findUserById"])
  })
})

describe("ownersAreCompatible", () => {
  it.each([
    ["an inflection", "UserRepo.x", "UserRepos.x"],
    ["an inflection read backwards", "UserRepos.x", "UserRepo.x"],
    ["the same owner", "UserRepo.x", "UserRepo.x"],
    ["two empty owners", "x", "y"],
    ["`::` owners read like dotted ones", "UserRepo::create", "UserRepos::create"],
    ["a matching a greedy pass would strand", "UsersUser.x", "UsersUserses.x"],
  ])("accepts %s", (_, base, head) => {
    expect(ownersAreCompatible(base, head)).toBe(true)
  })

  it.each([
    ["a prefix that is not an inflection", "UserRepo.x", "SuperuserRepo.x"],
    ["a stem that is a prefix of another", "RepoManager.x", "ReportManager.x"],
    ["a stem that gained a suffix", "CacheStore.x", "CachedStore.x"],
    ["an abbreviation", "UserRepo.x", "UsersRepository.x"],
    ["a bare abbreviation", "Repo.x", "Repository.x"],
    ["an unpartnered token", "UserRepo.x", "AdminRepo.x"],
    ["an extra token", "UserRepo.x", "UserRepoV2.x"],
    ["a differing first token", "OrderService.x", "InvoiceService.x"],
    ["an unrelated `::` owner", "UserRepo::create", "AdminRepo::create"],
    ["one empty owner against one that is not", "findById", "UserRepo.findById"],
    ["one owner against an empty one", "UserRepo.findById", "findById"],
    ["owners that match only by displacing without checking", "UserUsers.x", "UsersAdmin.x"],
    ["a stem that is an abbreviation", "ConManager.x", "ControllerManager.x"],
    ["a stem inflected some other way", "OrderService.x", "OrderingService.x"],
    ["owners sharing two of three tokens", "UserRepoService.x", "AdminRepoService.x"],
    ["a stem too short to be evidence", "IdMap.x", "IdentityMap.x"],
    ["another namespace", "Billing.Store.x", "Shipping.Store.x"],
    ["a namespace with an extra token", "User.Store.x", "UserAdmin.Store.x"],
    ["a merely similar namespace", "Repo.Store.x", "Report.Store.x"],
    ["one namespace more", "Services.UserRepo.x", "UserRepo.x"],
    ["one nesting more", "Users.Repo.x", "Users.Repo.Inner.x"],
  ])("refuses %s", (_, base, head) => {
    expect(ownersAreCompatible(base, head)).toBe(false)
  })

  it("refuses an owner segment with more tokens than the search will take, unless identical", () => {
    const wide = (last: string) =>
      `${Array.from({ length: 40 }, (_, i) => `Seg${i}`).join("")}${last}.x`
    expect(ownersAreCompatible(wide("Tail"), wide("Tail"))).toBe(true)
    expect(ownersAreCompatible(wide("Tail"), wide("Tails"))).toBe(false)
  })
})

describe("the owner gate is stage 4's alone", () => {
  it("leaves stage 3 to pair a lone base whose owner the gate would refuse", () => {
    const at = (file: string, name: string) =>
      method(file, name, "same", { rules: guardedBody("id") })
    const result = matchStageLogicFingerprint(
      [at("src/a.ts", "UserRepo.getUser")],
      [at("src/b.ts", "UsersRepository.getUser")],
    )
    expect(result.matched.map((pair) => pair.rationale)).toEqual(["logic-fingerprint"])
  })
})
