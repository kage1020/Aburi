import { fp, guardedBody, makeIR, makeSymbol, sig } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, matchStageNameSignature } from "../src"

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
    expect(
      pairs(
        [fn("src/legacy/runner.ts", "main", "aaa")],
        [fn("src/tools/scaffold.ts", "main", "bbb")],
      ),
    ).toEqual([])
  })

  it("does not pair a set of them in id order", () => {
    const base = ["p", "q", "r"].map((f) => fn(`src/${f}.ts`, "main", `a${f}`))
    const head = ["x", "y", "z"].map((f) => fn(`src/${f}.ts`, "main", `b${f}`))
    expect(pairs(base, head)).toEqual([])
  })

  it("measures distinct tokens, so an owner that repeats the last segment adds nothing", () => {
    expect(
      pairs([method("src/a.ts", "Main.main", "aaa")], [method("src/b.ts", "Main.main", "bbb")]),
    ).toEqual([])
  })

  it("covers a name with no tokens at all", () => {
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
    expect(
      pairs(
        [fn("src/a.ts", "получитьПользователя", "aaa")],
        [fn("src/b.ts", "получитьПользователя", "bbb")],
      ),
    ).toEqual(["ts:src/a.ts#получитьПользователя -> ts:src/b.ts#получитьПользователя"])
  })

  it("still refuses a single Cyrillic word, as it refuses a single English one", () => {
    expect(pairs([fn("src/a.ts", "главная", "aaa")], [fn("src/b.ts", "главная", "bbb")])).toEqual(
      [],
    )
  })

  it("still refuses a long single English word", () => {
    expect(
      pairs([fn("src/a.ts", "initialize", "aaa")], [fn("src/b.ts", "initialize", "bbb")]),
    ).toEqual([])
  })

  it("still refuses a single word of a caseless alphabetic script", () => {
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
    expect(
      pairs(
        [fn("src/a.ts", "ユーザー情報を取得する", "aaa")],
        [fn("src/b.ts", "注文履歴を保存する", "bbb")],
      ),
    ).toEqual([])
  })

  it("leaves stages 1 to 3 where they were", () => {
    expect(
      pairs(
        [fn("src/a.ts", "ユーザー情報を取得する", "same")],
        [fn("src/b.ts", "ユーザー情報を取得する", "same")],
      ),
    ).toEqual(["ts:src/a.ts#ユーザー情報を取得する -> ts:src/b.ts#ユーザー情報を取得する"])
  })
})

describe("a single word is a single word, however it is written", () => {
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
    expect(
      pairs([method("src/a.ts", "Main.main", "aaa")], [method("src/b.ts", "Mains.main", "bbb")]),
    ).toEqual([])
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

  it("leaves stage 3 to pair a one-token name on a logic fingerprint that names something", () => {
    const body = { rules: guardedBody("argv.length === 0") }
    expect(
      pairs([fn("src/a.ts", "main", "same", body)], [fn("src/b.ts", "main", "same", body)]),
    ).toEqual(["ts:src/a.ts#main -> ts:src/b.ts#main"])
    expect(pairs([fn("src/a.ts", "main", "same")], [fn("src/b.ts", "main", "same")])).toEqual([])
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
