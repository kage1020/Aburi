import { describe, expect, it } from "vitest"
import {
  jaccard,
  jaccardTokens,
  lastSegment,
  memberSimilarity,
  nameSimilarity,
  ownersAreCompatible,
  tokenizeName,
} from "../src"
import { createNameScorer } from "../src/similarity"

describe("tokenizeName", () => {
  it("splits camelCase, snake_case, dotted and static-scope segments", () => {
    expect(tokenizeName("InvoiceService.createInvoice")).toEqual(["invoice", "service", "create"])
    expect(tokenizeName("user_repo::get_user_by_id")).toEqual(["user", "repo", "get", "by", "id"])
    expect(tokenizeName("ns.SubNs.Foo")).toEqual(["ns", "sub", "foo"])
  })

  it("returns empty tokens for empty input", () => {
    expect(tokenizeName("")).toEqual([])
  })
})

describe("jaccard", () => {
  it("returns 1 for both empty (they represent the same 'no-tokens' pool)", () => {
    expect(jaccard([], [])).toBe(1)
  })
  it("returns 0 when only one side is empty", () => {
    expect(jaccard(["a"], [])).toBe(0)
  })
  it("computes standard intersection over union", () => {
    expect(jaccard(["a", "b"], ["a"])).toBeCloseTo(0.5, 5)
  })
})

describe("nameSimilarity", () => {
  it("gives full score to identical qualified names", () => {
    expect(nameSimilarity("Foo.bar", "Foo.bar")).toBe(1)
  })
  it("penalises unrelated names", () => {
    expect(nameSimilarity("Foo.bar", "Zzz.qux")).toBe(0)
  })
})

describe("memberSimilarity", () => {
  it("reads the last segment, leaving the owner to the gate", () => {
    // The double count the owner gate used to carry: the whole-name Jaccard is depressed by a
    // renamed owner, and the owner axis then charged for the same difference again.
    expect(memberSimilarity("UserRepo.getUser", "UsersRepository.getUser")).toBe(1)
    expect(nameSimilarity("UserRepo.getUser", "UsersRepository.getUser")).toBeCloseTo(0.4, 5)
  })
  it("still separates two member names under one owner", () => {
    expect(memberSimilarity("UserRepo.getUser", "UserRepo.getUsers")).toBeCloseTo(1 / 3, 5)
  })
  it("is the whole name when there is no owner", () => {
    expect(memberSimilarity("getUser", "getUsers")).toBeCloseTo(1 / 3, 5)
  })
})

describe("lastSegment", () => {
  it("returns the segment after the last dot", () => {
    expect(lastSegment("Cls.method")).toBe("method")
  })
  it("returns the segment after ::", () => {
    expect(lastSegment("Cls::static")).toBe("static")
  })
  it("returns the whole name if no separator", () => {
    expect(lastSegment("plain")).toBe("plain")
  })
})

describe("jaccardTokens", () => {
  it("tokenises both sides before the Jaccard", () => {
    expect(jaccardTokens("Foo.bar", "Foo.bar")).toBe(1)
    expect(jaccardTokens("Foo.bar", "Foo.baz")).toBeCloseTo(1 / 3, 5)
  })
})

describe("createNameScorer", () => {
  // The memo exists so stage 4 does not re-split the same names for every pair it scores.
  // A table that answers a question differently from the function it stands in for would be
  // a silent change of the matching rule, so the two are held against each other rather than
  // the memo being tested on its own terms.
  const names = [
    "main",
    "Repo.getUser",
    "Repo.getUsers",
    "UserRepo.getUser",
    "UsersRepository.getUser",
    "A.B.C.handle",
    "Cls::staticMethod",
    "snake_case_name",
    "get2Users",
    "",
  ]

  it("answers exactly as the uncached formulas do, for every pair", () => {
    const scorer = createNameScorer()
    const disagreements: string[] = []
    for (const base of names) {
      for (const head of names) {
        if (scorer.name(base, head) !== nameSimilarity(base, head)) {
          disagreements.push(`name(${base}, ${head})`)
        }
        if (scorer.member(base, head) !== memberSimilarity(base, head)) {
          disagreements.push(`member(${base}, ${head})`)
        }
        if (scorer.ownersCompatible(base, head) !== ownersAreCompatible(base, head)) {
          disagreements.push(`ownersCompatible(${base}, ${head})`)
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  it("answers the same on a repeat as on the first ask", () => {
    // The point of the table is that the second ask does not recompute; the point of this is
    // that it does not answer differently either.
    const scorer = createNameScorer()
    const first = names.map((base) => names.map((head) => scorer.name(base, head)))
    const second = names.map((base) => names.map((head) => scorer.name(base, head)))
    expect(second).toEqual(first)
  })

  it("keeps two scorers independent", () => {
    const one = createNameScorer()
    one.name("Repo.getUser", "Repo.getUsers")
    const two = createNameScorer()
    expect(two.name("Repo.getUser", "Repo.getUsers")).toBe(
      nameSimilarity("Repo.getUser", "Repo.getUsers"),
    )
  })
})
