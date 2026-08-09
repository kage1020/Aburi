import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, matchStageNameSignature } from "../src"
import { fp, makeIR, makeSymbol, sig } from "./fixtures"

/**
 * §3.4.3's threshold table demands a higher score the less the name has to say, and the row
 * for a one-token name reads 1.0. That was written as an impossible score, but it is a
 * reachable one: an identical name, an identical signature and an identical owner give
 * `0.5 + 0.3 + 0.2`, exactly 1 in IEEE 754. So the row admitted exactly the pairings it
 * meant to refuse — two unrelated top-level `main(x: string): void` joined into one
 * `moved+changed`, which is what `--fail-on moved` gates on.
 *
 * The demand the row wanted to make is off the top of the scale, so it is not a threshold.
 * It is an admissibility rule, alongside the signature-less one: a Symbol whose qualified name
 * carries a single distinct token is not paired in stage 4 at all.
 *
 * The count is over the **qualified name**, which is the whole of what §3.4 reads about a
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
    // Three a side, every pairing scoring 1, so §3.8's id keys chose which unrelated `main`
    // moved into which. The pairing was arbitrary because the candidates were indistinguishable.
    const base = ["p", "q", "r"].map((f) => fn(`src/${f}.ts`, "main", `a${f}`))
    const head = ["x", "y", "z"].map((f) => fn(`src/${f}.ts`, "main", `b${f}`))
    expect(pairs(base, head)).toEqual([])
  })

  it("counts distinct tokens, so an owner that repeats the last segment adds nothing", () => {
    // `Main.main` tokenises to `{main}`: the token sets are deduped, so an owner that repeats
    // its member name adds nothing a Jaccard can see. The rule counts what the score can.
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

describe("a script with no ASCII case boundary is one token, whatever it says", () => {
  // `tokenizeName` finds camel humps by comparing code points against `a`-`z` and `A`-`Z`, so
  // a name in a script that has no such boundary comes back whole however much it says. The
  // count is a proxy for that, and here the proxy is wrong: `ユーザー情報を取得する` is not a
  // name two unrelated Symbols carry by coincidence the way two carry `main`.
  //
  // The rule refuses them anyway, and these pin that as known rather than discovered. What it
  // costs is a stage-4 move — a cross-file move git did not record, with an edited body.
  // Measuring the name by something other than a bare token count is §3.4.1's to change, and
  // these tests are what will fail when it does.

  it("counts a Japanese name as one token", () => {
    expect(
      pairs(
        [fn("src/legacy/user.ts", "ユーザー情報を取得する", "aaa")],
        [fn("src/api/user.ts", "ユーザー情報を取得する", "bbb")],
      ),
    ).toEqual([])
  })

  it("counts a Chinese name as one token", () => {
    expect(
      pairs([fn("src/a.ts", "获取用户信息", "aaa")], [fn("src/b.ts", "获取用户信息", "bbb")]),
    ).toEqual([])
  })

  it("does not see the camel hump in a Cyrillic name either", () => {
    expect(
      pairs(
        [fn("src/a.ts", "получитьПользователя", "aaa")],
        [fn("src/b.ts", "получитьПользователя", "bbb")],
      ),
    ).toEqual([])
  })

  it("splits such a name on a separator, and on its ASCII half", () => {
    // Two tokens each, so both are read and pair. The boundary is the tokeniser's alphabet,
    // not the script.
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

  it("leaves stages 1 to 3 to carry these names", () => {
    // Which is what keeps the loss narrow: an unchanged move is stage 3's, and an unmoved
    // change never reaches stage 4 at all.
    expect(
      pairs(
        [fn("src/a.ts", "ユーザー情報を取得する", "same")],
        [fn("src/b.ts", "ユーザー情報を取得する", "same")],
      ),
    ).toEqual(["ts:src/a.ts#ユーザー情報を取得する -> ts:src/b.ts#ユーザー情報を取得する"])
  })
})

describe("the rule is scoped to a pairing, and to stage 4", () => {
  it("reads the base as well as the head", () => {
    // The property belongs to a pairing. This was once read off the head alone, on the
    // arithmetic that one token against two or more is a Jaccard of at most 1/2 and so caps
    // the total at 0.75 whichever side is short. That held while the name axis read the whole
    // qualified name. §3.4.6's gate moved the axis to the last segment, and a one-token base
    // reaches the top of the scale again: `Main.main` clears the gate against `Mainly.main`
    // on an abbreviated owner, and their member names are identical.
    expect(
      pairs([method("src/a.ts", "Main.main", "aaa")], [method("src/b.ts", "Mainly.main", "bbb")]),
    ).toEqual([])
    // And the mirror, which is a separate skip in a separate loop: the short name on the head
    // reaches an admissible base the same way round.
    expect(
      pairs([method("src/a.ts", "Mainly.main", "aaa")], [method("src/b.ts", "Main.main", "bbb")]),
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
