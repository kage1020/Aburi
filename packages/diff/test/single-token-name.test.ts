import { fp, makeIR, makeSymbol, sig } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, matchStageNameSignature } from "../src"

/**
 * diff-algorithm.md's threshold table demands a higher score the less the name has to say, and the
 * row for a one-token name reads 1.0. That was written as an impossible score, but it is a
 * reachable one: an identical name, an identical signature and an identical owner give `0.5 + 0.3 +
 * 0.2`, exactly 1 in IEEE 754. So the row admitted exactly the pairings it meant to refuse — two
 * unrelated top-level `main(x: string): void` joined into one `moved+changed`, which is what
 * `--fail-on moved` gates on.
 *
 * The demand the row wanted to make is off the top of the scale, so it is not a threshold.
 * It is an admissibility rule, alongside the signature-less one: a Symbol whose qualified name
 * says only one thing is not paired in stage 4 at all.
 *
 * What counts as "one thing" is `nameEvidence`, not the distinct-token count. The two agree on
 * a name whose words the tokeniser can find, and part company on a run it cannot segment,
 * where the measure reads the run rather than the token: `ユーザー.取得` is two tokens and
 * two runs, and `获取用户信息` is one token and six characters. A run counts as its characters
 * over the longest a single word of that script runs, which is a floor on the words in it, so
 * a phrase is admitted and a single long word is not. The last two blocks here are that
 * difference and the limit of it.
 *
 * The measure is over the **qualified name**, which is the whole of what stage 4 reads about a
 * Symbol's identity — not over the last segment alone, which is what the threshold table
 * reads. `UserRepo.get` has one token in its last segment and three in its name, and it goes
 * on pairing.
 */

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

const ONE_INPUT = { name: "x", type: "string" } as const
const ONE_STRING = sig({ inputs: [ONE_INPUT] })

function fn(file: string, name: string, body: string, over: Partial<IRSymbol> = {}): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    signature: ONE_STRING,
    fingerprint: fp(body),
    source: { file, startLine: 1, endLine: 2 },
    ...over,
  })
}

function method(file: string, name: string, body: string): IRSymbol {
  return fn(file, name, body, { kind: "method" })
}

/** Every pairing the diff reports, as `before -> after`, whatever the status. */
function pairs(base: IRSymbol[], head: IRSymbol[]): string[] {
  const diff = buildDiff({
    baseIR: makeIR({ symbols: base }),
    headIR: makeIR({ symbols: head }),
    base: IR_REF,
    head: IR_REF,
  })
  return diff.symbols.flatMap((change) =>
    "before" in change && "after" in change ? [`${change.before.id} -> ${change.after.id}`] : [],
  )
}

describe("a one-token name is not evidence of identity", () => {
  it("does not join two unrelated top-level `main`", () => {
    // The reported case. Both are `main(x: string): void` at the top level of their file, so
    // name, signature and owner all agree and the score is exactly 1 — and everything the
    // score saw was one word and a signature that half a CLI shares.
    expect(
      pairs(
        [fn("src/legacy/runner.ts", "main", "aaa")],
        [fn("src/tools/scaffold.ts", "main", "bbb")],
      ),
    ).toEqual([])
  })

  it("does not pair a set of them in id order", () => {
    // Three a side, every pairing scoring 1, so the sweep's id keys chose which unrelated `main`
    // moved into which. The pairing was arbitrary because the candidates were indistinguishable.
    const base = ["p", "q", "r"].map((f) => fn(`src/${f}.ts`, "main", `a${f}`))
    const head = ["x", "y", "z"].map((f) => fn(`src/${f}.ts`, "main", `b${f}`))
    expect(pairs(base, head)).toEqual([])
  })

  it("measures distinct tokens, so an owner that repeats the last segment adds nothing", () => {
    // `Main.main` tokenises to `{main}`: the token sets are deduped, so an owner that repeats
    // its member name adds nothing a Jaccard can see. The rule measures what the score can.
    expect(
      pairs([method("src/a.ts", "Main.main", "aaa")], [method("src/b.ts", "Main.main", "bbb")]),
    ).toEqual([])
  })

  it("covers a name with no tokens at all", () => {
    // `_` splits away to nothing, and `jaccard` answers 1.0 for two empty token sets, so a
    // nameless name scored a perfect match against every other. `<= 1` rather than `=== 1`
    // is what closes that, the same way `thresholdFor` writes it.
    expect(pairs([fn("src/a.ts", "_", "aaa")], [fn("src/b.ts", "_", "bbb")])).toEqual([])
  })

  it("reports both sides plainly instead", () => {
    const diff = buildDiff({
      baseIR: makeIR({ symbols: [fn("src/legacy/runner.ts", "main", "aaa")] }),
      headIR: makeIR({ symbols: [fn("src/tools/scaffold.ts", "main", "bbb")] }),
      base: IR_REF,
      head: IR_REF,
    })
    expect(diff.summary.added).toBe(1)
    expect(diff.summary.removed).toBe(1)
    expect(diff.summary.moved).toBe(0)
    expect(diff.summary.movedChanged).toBe(0)
  })
})

describe("the qualified name is what carries the evidence", () => {
  it("still pairs a method whose last segment alone is one token", () => {
    // `UserRepo.get`: one token in the last segment, three in the name. Skipping on the last
    // segment — the measure the threshold table uses — would take this move away.
    expect(
      pairs(
        [method("src/a.ts", "UserRepo.get", "aaa")],
        [method("src/b.ts", "UserRepo.get", "bbb")],
      ),
    ).toEqual(["ts:src/a.ts#UserRepo.get -> ts:src/b.ts#UserRepo.get"])
  })

  it("still pairs a two-token name whose owner supplies the second token", () => {
    expect(
      pairs([method("src/a.ts", "Foo.main", "aaa")], [method("src/b.ts", "Foo.main", "bbb")]),
    ).toEqual(["ts:src/a.ts#Foo.main -> ts:src/b.ts#Foo.main"])
  })

  it("holds those names to an exact match, as the table's first row says", () => {
    // The row is still live: `UserRepo.get` has a one-token last segment, so it needs the
    // full 1.0, and a changed signature costs it. Only the admissibility rule moved.
    const head = makeSymbol({
      id: "ts:src/b.ts#UserRepo.get",
      name: "UserRepo.get",
      kind: "method",
      signature: sig({ inputs: [{ name: "x", type: "number" }] }),
      fingerprint: fp("bbb"),
      source: { file: "src/b.ts", startLine: 1, endLine: 2 },
    })
    expect(pairs([method("src/a.ts", "UserRepo.get", "aaa")], [head])).toEqual([])
  })
})

describe("a name the tokeniser cannot segment still says what it says", () => {
  // `tokenizeName` finds word boundaries by case, so a name in a script that has no case comes
  // back whole however much it says. The rule used to read that count as the measure of how
  // much a name says, and refused `ユーザー情報を取得する` on the same footing as `main` —
  // which is wrong about it: two unrelated Symbols do not carry that name by coincidence.
  //
  // `nameEvidence` measures it instead: a run of such a script counts as its characters over
  // the longest a single word of it runs — three for Han, six for kana and Hangul — which is
  // a floor on how many words are in the run. A phrase clears it. A single word does not,
  // which is the next block.

  it("pairs a Japanese name across a file move with an edited body", () => {
    expect(
      pairs(
        [fn("src/legacy/user.ts", "ユーザー情報を取得する", "aaa")],
        [fn("src/api/user.ts", "ユーザー情報を取得する", "bbb")],
      ),
    ).toEqual([
      "ts:src/legacy/user.ts#ユーザー情報を取得する -> ts:src/api/user.ts#ユーザー情報を取得する",
    ])
  })

  it("pairs a Chinese name the same way", () => {
    expect(
      pairs([fn("src/a.ts", "获取用户信息", "aaa")], [fn("src/b.ts", "获取用户信息", "bbb")]),
    ).toEqual(["ts:src/a.ts#获取用户信息 -> ts:src/b.ts#获取用户信息"])
  })

  it("pairs a Korean name the same way", () => {
    expect(
      pairs([fn("src/a.ts", "사용자정보조회", "aaa")], [fn("src/b.ts", "사용자정보조회", "bbb")]),
    ).toEqual(["ts:src/a.ts#사용자정보조회 -> ts:src/b.ts#사용자정보조회"])
  })

  it("sees the camel hump in a Cyrillic name, which is a second token", () => {
    // Not the morphemic rule: the case boundary is Unicode now, so this splits into two
    // tokens the way `getUser` does and is admissible on the count alone.
    expect(
      pairs(
        [fn("src/a.ts", "получитьПользователя", "aaa")],
        [fn("src/b.ts", "получитьПользователя", "bbb")],
      ),
    ).toEqual(["ts:src/a.ts#получитьПользователя -> ts:src/b.ts#получитьПользователя"])
  })

  it("still refuses a single Cyrillic word, as it refuses a single English one", () => {
    // No hump, so one token and one word. `главная` is Russian for `main` and is treated as
    // `main` is — the rule is about how much a name says, not about which script says it.
    expect(pairs([fn("src/a.ts", "главная", "aaa")], [fn("src/b.ts", "главная", "bbb")])).toEqual(
      [],
    )
  })

  it("still refuses a long single English word", () => {
    // Length is not the measure. `initialize` is ten characters and one word, and two
    // unrelated top-level `initialize(x: string)` are exactly the coincidence the rule is for.
    expect(
      pairs([fn("src/a.ts", "initialize", "aaa")], [fn("src/b.ts", "initialize", "bbb")]),
    ).toEqual([])
  })

  it("still refuses a single word of a caseless alphabetic script", () => {
    // Arabic has no case, so this is one token — but its characters are letters rather than
    // morphemes, so it is one word and the count was already right about it. A multi-word
    // Arabic identifier separates its words, and the tokeniser splits on the separator.
    expect(pairs([fn("src/a.ts", "مستخدم", "aaa")], [fn("src/b.ts", "مستخدم", "bbb")])).toEqual([])
    expect(
      pairs([method("src/a.ts", "مستخدم.احصل", "aaa")], [method("src/b.ts", "مستخدم.احصل", "bbb")]),
    ).toEqual(["ts:src/a.ts#مستخدم.احصل -> ts:src/b.ts#مستخدم.احصل"])
  })

  it("splits such a name on a separator, and on its Latin half", () => {
    // Unchanged: both were admissible before this on their token count alone.
    expect(
      pairs(
        [method("src/a.ts", "ユーザー.取得", "aaa")],
        [method("src/b.ts", "ユーザー.取得", "bbb")],
      ),
    ).toEqual(["ts:src/a.ts#ユーザー.取得 -> ts:src/b.ts#ユーザー.取得"])
    expect(
      pairs(
        [method("src/a.ts", "UserRepo.取得", "aaa")],
        [method("src/b.ts", "UserRepo.取得", "bbb")],
      ),
    ).toEqual(["ts:src/a.ts#UserRepo.取得 -> ts:src/b.ts#UserRepo.取得"])
  })

  it("does not pair two different names that merely share a script", () => {
    // Admissibility is not a score. Both say plenty, and they say different things: the
    // member Jaccard is 0, so the composite cannot reach any row of the table.
    expect(
      pairs(
        [fn("src/a.ts", "ユーザー情報を取得する", "aaa")],
        [fn("src/b.ts", "注文履歴を保存する", "bbb")],
      ),
    ).toEqual([])
  })

  it("leaves stages 1 to 3 where they were", () => {
    // An unchanged move is still stage 3's, decided on the fingerprint without asking the
    // name to carry anything.
    expect(
      pairs(
        [fn("src/a.ts", "ユーザー情報を取得する", "same")],
        [fn("src/b.ts", "ユーザー情報を取得する", "same")],
      ),
    ).toEqual(["ts:src/a.ts#ユーザー情報を取得する -> ts:src/b.ts#ユーザー情報を取得する"])
  })
})

describe("a single word is a single word, however it is written", () => {
  // The floor is what separates these from the block above. Counting each character as a word
  // would admit every one of them: `メイン` is `main` in three characters, `초기화` is
  // `initialize` in three, `ハンドラー` is `handler` in five. Two unrelated Symbols carry
  // these by coincidence exactly as they carry their English counterparts, so the rule this
  // file is about has to go on refusing them.
  const oneWord = ["値", "取得", "する", "初期化", "メイン", "초기화", "ユーザー", "ハンドラー"]

  it.each(oneWord)("refuses two unrelated top-level `%s`", (name) => {
    expect(pairs([fn("src/a.ts", name, "aaa")], [fn("src/b.ts", name, "bbb")])).toEqual([])
  })

  it("refuses them on the base side too", () => {
    expect(
      pairs([method("src/a.ts", "ハンドラー.実行", "aaa")], [method("src/b.ts", "実行", "bbb")]),
    ).toEqual([])
  })

  it("admits the phrases they are built into", () => {
    // The same characters, said at phrase length: the floor clears 1 and the pairing is back.
    expect(
      pairs(
        [fn("src/a.ts", "初期化処理を実行する", "aaa")],
        [fn("src/b.ts", "初期化処理を実行する", "bbb")],
      ),
    ).toEqual(["ts:src/a.ts#初期化処理を実行する -> ts:src/b.ts#初期化処理を実行する"])
  })

  it("gives the same verdict for either normalisation of the name", () => {
    // `ガイド取得` decomposed is one more code point than composed. The tokeniser normalises
    // first, so the measure does not turn on which spelling reached the IR.
    const composed = "\u30AC\u30A4\u30C9\u53D6\u5F97"
    const decomposed = "\u30AB\u3099\u30A4\u30C9\u53D6\u5F97"
    expect(pairs([fn("src/a.ts", composed, "aaa")], [fn("src/b.ts", composed, "bbb")])).toEqual([
      `ts:src/a.ts#${composed} -> ts:src/b.ts#${composed}`,
    ])
    expect(pairs([fn("src/a.ts", decomposed, "aaa")], [fn("src/b.ts", decomposed, "bbb")])).toEqual(
      [`ts:src/a.ts#${decomposed} -> ts:src/b.ts#${decomposed}`],
    )
  })
})

describe("what admissibility buys such a name, and what it does not", () => {
  it("recovers the signature-identical move, not the whole band", () => {
    // Admissibility is stage 4's door, not its threshold. The name is still one token, so
    // `thresholdFor` reads its last segment as one and demands the full 1.0 — which an
    // identical signature reaches and an edited one does not. A Latin name of the same
    // reach has two tokens in its last segment and the 0.95 row to fall back on.
    const added = sig({ inputs: [ONE_INPUT, { name: "y", type: "number" }] })
    const head = (name: string): IRSymbol =>
      makeSymbol({
        id: `ts:src/b.ts#${name}`,
        name,
        signature: added,
        fingerprint: fp("bbb"),
        source: { file: "src/b.ts", startLine: 1, endLine: 2 },
      })
    expect(
      pairs([fn("src/a.ts", "ユーザー情報を取得する", "aaa")], [head("ユーザー情報を取得する")]),
    ).toEqual([])
    expect(
      pairs([fn("src/a.ts", "getUserInformation", "aaa")], [head("getUserInformation")]),
    ).toEqual(["ts:src/a.ts#getUserInformation -> ts:src/b.ts#getUserInformation"])
  })
})

describe("the rule is scoped to a pairing, and to stage 4", () => {
  it("reads the base as well as the head", () => {
    // The property belongs to a pairing. This was once read off the head alone, on the
    // arithmetic that one token against two or more is a Jaccard of at most 1/2 and so caps
    // the total at 0.75 whichever side is short. That held while the name axis read the whole
    // qualified name. The owner gate moved the axis to the last segment, and a one-token base
    // reaches the top of the scale again: `Main.main` is one deduped token, it clears the gate
    // against `Mains.main` by inflection, and their member names are identical.
    expect(
      pairs([method("src/a.ts", "Main.main", "aaa")], [method("src/b.ts", "Mains.main", "bbb")]),
    ).toEqual([])
    // And the mirror, which is a separate skip in a separate loop: the short name on the head
    // reaches an admissible base the same way round.
    expect(
      pairs([method("src/a.ts", "Mains.main", "aaa")], [method("src/b.ts", "Main.main", "bbb")]),
    ).toEqual([])
  })

  it("still refuses the heads a short base could never have reached anyway", () => {
    expect(pairs([fn("src/a.ts", "main", "aaa")], [fn("src/b.ts", "mainRunner", "bbb")])).toEqual(
      [],
    )
    expect(pairs([fn("src/a.ts", "main", "aaa")], [method("src/b.ts", "Foo.main", "bbb")])).toEqual(
      [],
    )
    expect(
      pairs([fn("src/a.ts", "main", "aaa")], [fn("src/b.ts", "mainRunnerEntry", "bbb")]),
    ).toEqual([])
  })

  it("leaves stage 3 to pair a one-token name on its fingerprint", () => {
    // An identical logic fingerprint is proof of its own, and it does not depend on the name
    // carrying anything. A `main` that moved file without changing is still a move.
    expect(pairs([fn("src/a.ts", "main", "same")], [fn("src/b.ts", "main", "same")])).toEqual([
      "ts:src/a.ts#main -> ts:src/b.ts#main",
    ])
  })

  it("leaves the rest of the table where it was", () => {
    const base = [fn("src/a.ts", "getUser", "aaa")]
    // 2 tokens → 0.95. `getUser` vs `getUsers` scores 0.5 on the name and does not pass.
    expect(pairs(base, [fn("src/b.ts", "getUsers", "bbb")])).toEqual([])
    expect(pairs(base, [fn("src/b.ts", "getUser", "bbb")])).toEqual([
      "ts:src/a.ts#getUser -> ts:src/b.ts#getUser",
    ])
  })

  it("still asks a 1-token last segment for the whole scale", () => {
    // `UserRepo.get` is admissible on its three name tokens, and then the first threshold row
    // holds it to 1.0. One added `throws` entry drops the signature axis to 5/6 and the total
    // to 0.95 — which the second row would have accepted. The row is the difference.
    const head = makeSymbol({
      id: "ts:src/b.ts#UserRepo.get",
      name: "UserRepo.get",
      kind: "method",
      signature: sig({ inputs: [ONE_INPUT], throws: ["AuthError", "RateLimitError"] }),
      fingerprint: fp("bbb"),
      source: { file: "src/b.ts", startLine: 1, endLine: 2 },
    })
    const base = makeSymbol({
      id: "ts:src/a.ts#UserRepo.get",
      name: "UserRepo.get",
      kind: "method",
      signature: sig({ inputs: [ONE_INPUT], throws: ["AuthError"] }),
      fingerprint: fp("aaa"),
      source: { file: "src/a.ts", startLine: 1, endLine: 2 },
    })
    expect(pairs([base], [head])).toEqual([])
  })

  it("holds a 2-token last segment to 0.95, above the default", () => {
    // Same shapes one token longer, so the second row governs. 0.95 passes and 0.9 — which
    // the 0.85 default would have taken — does not.
    const at = (file: string, seed: string, signature: ReturnType<typeof sig>): IRSymbol =>
      makeSymbol({
        id: `ts:${file}#UserRepo.getUser`,
        name: "UserRepo.getUser",
        kind: "method",
        signature,
        fingerprint: fp(seed),
        source: { file, startLine: 1, endLine: 2 },
      })
    const oneThrow = sig({ inputs: [ONE_INPUT], throws: ["AuthError"] })
    expect(
      pairs(
        [at("src/a.ts", "aaa", oneThrow)],
        [
          at(
            "src/b.ts",
            "bbb",
            sig({ inputs: [ONE_INPUT], throws: ["AuthError", "RateLimitError"] }),
          ),
        ],
      ),
    ).toEqual(["ts:src/a.ts#UserRepo.getUser -> ts:src/b.ts#UserRepo.getUser"])
    expect(
      pairs(
        [at("src/a.ts", "aaa", oneThrow)],
        [
          at(
            "src/b.ts",
            "bbb",
            sig({ inputs: [{ name: "x", type: "number" }], throws: ["AuthError"] }),
          ),
        ],
      ),
    ).toEqual([])
  })

  it("removes the head from the stage rather than from the diff", () => {
    const base = fn("src/a.ts", "main", "aaa")
    const head = fn("src/b.ts", "main", "bbb")
    const result = matchStageNameSignature([base], [head])
    expect(result.matched).toEqual([])
    expect(result.remainingBase).toEqual([base])
    expect(result.remainingHead).toEqual([head])
  })
})
