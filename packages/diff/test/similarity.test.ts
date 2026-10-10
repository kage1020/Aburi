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
    expect(tokenizeName("mapǅevo")).toEqual(["map", "ǆevo"])
  })

  it("finds the hump in a cased script outside the BMP", () => {
    expect(tokenizeName("\u{10428}\u{10401}")).toEqual(["\u{10428}", "\u{10429}"])
    expect(tokenizeName("\u{1E922}\u{1E901}")).toEqual(["\u{1E922}", "\u{1E923}"])
    // And the digit boundary, which an astral `\p{Nd}` lost the same way.
    expect(tokenizeName("get\u{1D7CE}")).toEqual(["get", "\u{1D7CE}"])
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

  it("counts a run it cannot segment by its characters, floored to words", () => {
    expect(nameEvidence("获取用户信息")).toBe(2)
    expect(nameEvidence("사용자정보조회")).toBe(7 / 6)
    // Four Han characters and six distinct kana (`ー` twice).
    expect(nameEvidence("ユーザー情報を取得する")).toBe(4 / 3 + 1)
  })

  it("refuses a single word of a script that writes no word boundary", () => {
    for (const oneWord of [
      "値",
      "取得",
      "する",
      "初期化",
      "メイン",
      "초기화",
      "ユーザー",
      "ハンドラー",
    ]) {
      expect({ name: oneWord, evidence: nameEvidence(oneWord) <= 1 }).toEqual({
        name: oneWord,
        evidence: true,
      })
    }
  })

  it("keeps a prolonged sound mark with the kana it lengthens", () => {
    expect(nameEvidence("ユーザー")).toBe(3 / 6)
    expect(nameEvidence("ー")).toBe(1 / 6)
  })

  it("is not a length measure — a long word is still one word", () => {
    expect(nameEvidence("initialize")).toBe(1)
    expect(nameEvidence("internationalization")).toBe(1)
    expect(nameEvidence("главная")).toBe(1)
  })

  it("counts a caseless alphabetic script by the word, not by the letter", () => {
    expect(nameEvidence("مستخدم")).toBe(1)
    expect(nameEvidence("مستخدم.احصل")).toBe(2)
  })

  it("counts an astral-plane character once, not twice", () => {
    expect(nameEvidence("\u{20BB7}")).toBe(1 / 3)
    expect(nameEvidence("\u{20BB7}\u{2A6B2}")).toBe(2 / 3)
  })

  it("adds one for whatever a mixed token has besides its morphemes", () => {
    expect(nameEvidence("UserRepo.取得")).toBe(2 + 2 / 3)
    expect(nameEvidence("取得User")).toBe(1 + 2 / 3)
  })

  it("dedups the way the token set does, inside a run as well as across tokens", () => {
    expect(nameEvidence("Main.main")).toBe(1)
    expect(nameEvidence("取得.取得")).toBe(2 / 3)
    expect(nameEvidence("取得取得")).toBe(nameEvidence("取得"))
    expect(nameEvidence("ああああ")).toBe(nameEvidence("あ"))
  })

  it("gives the same answer for either normalisation of a name", () => {
    expect(nameEvidence("\u30AB\u3099")).toBe(nameEvidence("\u30AC"))
    expect(nameEvidence("\u1100\u1161\u11A8")).toBe(nameEvidence("\uAC01"))
    expect(tokenizeName("\u30AB\u3099")).toEqual(tokenizeName("\u30AC"))
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
  it("returns the segment after the last separator of either kind", () => {
    expect(lastSegment("C::Inner.g")).toBe("g")
    expect(lastSegment("C::K::s")).toBe("s")
    expect(lastSegment("A.C::m")).toBe("m")
  })
})

describe("jaccardTokens", () => {
  it("tokenises both sides before the Jaccard", () => {
    expect(jaccardTokens("Foo.bar", "Foo.bar")).toBe(1)
    expect(jaccardTokens("Foo.bar", "Foo.baz")).toBeCloseTo(1 / 3, 5)
  })
})

describe("createNameScorer", () => {
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
