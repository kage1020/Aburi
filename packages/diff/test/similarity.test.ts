import { describe, expect, it } from "vitest"
import {
  jaccard,
  jaccardTokens,
  lastSegment,
  memberSimilarity,
  nameEvidence,
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

  it("finds the camel hump in any cased script, not only in Latin", () => {
    // The boundary test is Unicode case. Cyrillic has case, so it has humps.
    expect(tokenizeName("получитьПользователя")).toEqual(["получить", "пользователя"])
    expect(tokenizeName("λάβεΧρήστη")).toEqual(["λάβε", "χρήστη"])
  })

  it("treats a titlecase digraph as opening a word", () => {
    // `ǅ` is Lt, neither Lu nor Ll. It opens a word exactly as an uppercase letter does, so
    // an ASCII-range test — and a `\\p{Lu}`-only one — would run it into the word before it.
    // The token comes back lowercased like every other, which for Lt is the Ll form.
    expect(tokenizeName("mapǅevo")).toEqual(["map", "ǆevo"])
  })

  it("splits a digit run in a non-ASCII script too", () => {
    expect(tokenizeName("пользователь2Id")).toEqual(["пользователь", "2", "id"])
  })

  it("leaves a caseless script whole, because there is no boundary in it to find", () => {
    expect(tokenizeName("ユーザー情報を取得する")).toEqual(["ユーザー情報を取得する"])
    expect(tokenizeName("获取用户信息")).toEqual(["获取用户信息"])
    expect(tokenizeName("مستخدم")).toEqual(["مستخدم"])
  })

  it("still splits such a name on a separator", () => {
    expect(tokenizeName("ユーザー.取得")).toEqual(["ユーザー", "取得"])
    expect(tokenizeName("UserRepo.取得")).toEqual(["user", "repo", "取得"])
  })
})

describe("nameEvidence", () => {
  it("agrees with the token count wherever the tokeniser finds the words", () => {
    expect(nameEvidence("main")).toBe(1)
    expect(nameEvidence("getUser")).toBe(2)
    expect(nameEvidence("InvoiceService.createInvoice")).toBe(3)
    expect(nameEvidence("")).toBe(0)
  })

  it("counts a morphemic character as the word it is", () => {
    // Six Han characters are six words with no boundary written between them, which is what
    // the token count cannot see.
    expect(nameEvidence("获取用户信息")).toBe(6)
    expect(nameEvidence("사용자정보조회")).toBe(7)
    expect(nameEvidence("ユーザー情報を取得する")).toBe(11)
  })

  it("keeps a prolonged sound mark with the kana it lengthens", () => {
    // U+30FC is script Common; under `Script` rather than `Script_Extensions` it would read
    // as a foreign character and add a spurious unit of its own.
    expect(nameEvidence("ユーザー")).toBe(4)
    expect(nameEvidence("ー")).toBe(1)
  })

  it("is not a length measure — a long word is still one word", () => {
    expect(nameEvidence("initialize")).toBe(1)
    expect(nameEvidence("internationalization")).toBe(1)
    expect(nameEvidence("главная")).toBe(1)
  })

  it("counts a caseless alphabetic script by the word, not by the letter", () => {
    // Arabic letters are letters. A multi-word Arabic identifier writes a separator, which
    // the tokeniser splits, so the count is already right about it.
    expect(nameEvidence("مستخدم")).toBe(1)
    expect(nameEvidence("مستخدم.احصل")).toBe(2)
  })

  it("counts an astral-plane Han character once, not twice", () => {
    // U+20BB7 is a surrogate pair in UTF-16. The scan iterates code points, so it is one
    // character and one word; counting UTF-16 units would double every Extension-B name.
    expect(nameEvidence("\u{20BB7}\u{20BB7}")).toBe(2)
    expect(nameEvidence("\u{20BB7}")).toBe(1)
  })

  it("adds one for whatever a mixed token has besides its morphemes", () => {
    expect(nameEvidence("UserRepo.取得")).toBe(4)
    expect(nameEvidence("取得User")).toBe(3)
  })

  it("dedups the way the token set does, since that is what the score reads", () => {
    expect(nameEvidence("Main.main")).toBe(1)
    expect(nameEvidence("取得.取得")).toBe(2)
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
