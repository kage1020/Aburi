import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { matchStageNameSignature } from "../src"
import { fp, makeSymbol, sig } from "./fixtures"

/**
 * §3.4.0's bucket key is `(kind, signatureNullness)`, which a bulk rename leaves in one piece:
 * every method of a renamed directory shares it, so stage 4 scored the whole cross-product and
 * took 64 s at 4000 symbols against §8.3's 2 s target.
 *
 * Within a bucket the bases are now indexed by the tokens of their member names, and a head
 * only sees the bases sharing one. That costs nothing in recall, and the reason is arithmetic:
 * `0.5 * member + 0.3 * signature + 0.2` has to reach 0.85, the lowest row of §3.4.3's table,
 * and the signature axis is worth at most 0.3 — so `member >= 0.7` for any pairing that
 * survives. A Jaccard that high is above zero, and a Jaccard above zero is a shared token.
 *
 * These are the cases where the narrowing could lose a pairing if that argument were wrong.
 */

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
    // The reported shape: same qualified name, different file, edited body. The member token
    // is the only thing left, and it is enough.
    expect(
      pairs(
        [method("src/old/a.ts", "Service.handleRequest", "a")],
        [method("src/new/a.ts", "Service.handleRequest", "b")],
      ),
    ).toEqual(["Service.handleRequest -> Service.handleRequest"])
  })

  it("pairs on the member token even when the signature moved", () => {
    // The other axis giving ground: an added `throws` drops the signature axis to 2/3, and an
    // unchanged 3-token member name carries the pairing to 0.5 + 0.2 + 0.2 = 0.9, over the
    // 0.85 row. Reachable only through the shared tokens, which is the property under test.
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
    // §3.4.3's table asks 0.85 of a 3-token member name and the other two axes cap at 0.5, so
    // the member axis must reach 0.7 — and changing one token of three gives 0.5. No renamed
    // member reaches stage 4's bar, so the index narrowing to shared tokens cannot cost one.
    expect(
      pairs(
        [method("src/a.ts", "Repo.loadConfigFile", "a")],
        [method("src/a.ts", "Repo.loadConfigFiles", "b")],
      ),
    ).toEqual([])
  })

  it("does not pair two members with no token in common", () => {
    // Nothing shared, so the index never offers the pair — and the score would not have
    // reached the threshold either. The narrowing agrees with the arithmetic.
    expect(
      pairs(
        [method("src/a.ts", "UserRepo.save", "a")],
        [method("src/a.ts", "UserRepo.delete", "b")],
      ),
    ).toEqual([])
  })

  it("holds the floor where the member axis alone decides", () => {
    // One token of two is a Jaccard of 1/3: 0.5/3 + 0.3 + 0.2 = 0.667, under every row. The
    // pair is reachable through `get`, and refused on the score rather than on the index.
    expect(
      pairs(
        [method("src/a.ts", "Repo.getUser", "a")],
        [method("src/a.ts", "Repo.getInvoice", "b")],
      ),
    ).toEqual([])
  })
})

describe("a member name with no tokens is indexed too", () => {
  // `Foo.Bar.` has an empty last segment and two tokens in its qualified name, so it is
  // admissible, and two of them score 1.0 on an axis comparing two empty sets. They carry no
  // token to be indexed under, so they need a key of their own — without one they would be
  // unreachable, which is a pairing lost to the index rather than to the score.

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

describe("a base is reachable through every token of its member name", () => {
  it("finds one whose shared token is not the first it carries", () => {
    // A bucket wide enough that the whole-bucket fallback cannot fire, and a head sharing only
    // a later token of its counterpart. Indexing a base under its first token alone — or under
    // the tokens of its whole qualified name — would leave this pairing unreachable.
    const distractors = Array.from({ length: 8 }, (_, i) =>
      method(`src/d${i}.ts`, `Repo.parseHeader${i}`, `d${i}`),
    )
    const base = [...distractors, method("src/a.ts", "Repo.emitConfigFile", "a")]
    const head = [method("src/b.ts", "Repo.emitConfigFile", "b")]
    expect(pairs(base, head)).toEqual(["Repo.emitConfigFile -> Repo.emitConfigFile"])
  })
})

describe("the shortcuts answer as the rule they stand in for", () => {
  // Reaching a base through several of its tokens, and answering §3.4.6's gate without running
  // it, are optimisations. Each has to give the answer the long way round gives, and these are
  // the shapes where a wrong shortcut is visible.

  it("scores a base reached through two shared tokens once", () => {
    // `{load, config}` on both sides, so the postings list is walked twice over the same base.
    // Counting it twice would offer §3.8 the same pairing twice.
    const base = [method("src/a.ts", "Repo.loadConfig", "a")]
    const head = [method("src/b.ts", "Repo.loadConfig", "b")]
    expect(pairs(base, head)).toEqual(["Repo.loadConfig -> Repo.loadConfig"])
    expect(matchStageNameSignature(base, head).matched).toHaveLength(1)
  })

  it("pairs a namespaced class whose namespace is unchanged", () => {
    // The first-segment shortcut is consulted here rather than short-circuited: the owners are
    // not identical, and their first segments are.
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
    // `{user}` against `{user, admin}` — refused on the count before any word is compared, the
    // same way the full gate would refuse it.
    expect(
      pairs(
        [method("src/a.ts", "User.Store.loadConfigFile", "a")],
        [method("src/b.ts", "UserAdmin.Store.loadConfigFile", "b")],
      ),
    ).toEqual([])
  })

  it("refuses a first segment whose token is merely similar", () => {
    // `repo` and `report` share a prefix and nothing else — §3.4.6 admits only inflection, and
    // the shortcut has to apply the same test rather than a looser one.
    expect(
      pairs(
        [method("src/a.ts", "Repo.Store.loadConfigFile", "a")],
        [method("src/b.ts", "Report.Store.loadConfigFile", "b")],
      ),
    ).toEqual([])
  })

  it("pairs a top-level function, which has no owner to shortcut", () => {
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

describe("the narrowing does not change what a bulk rename reports", () => {
  it("pairs every method of a renamed directory", () => {
    const members = ["loadConfig", "saveConfig", "resetConfig", "watchConfig"]
    const base = members.map((m, i) => method(`src/old/mod${i}.ts`, `Store.${m}`, `a${i}`))
    const head = members.map((m, i) => method(`src/new/mod${i}.ts`, `Store.${m}`, `b${i}`))
    expect(pairs(base, head).sort()).toEqual(members.map((m) => `Store.${m} -> Store.${m}`).sort())
  })

  it("still separates the ones whose owners are unrelated", () => {
    // Same member token throughout, so the index offers every pair and §3.4.6's gate is what
    // refuses them. The index narrows; it does not decide.
    const base = [method("src/a.ts", "UserRepo.handleRequest", "a")]
    const head = [method("src/b.ts", "AdminRepo.handleRequest", "b")]
    expect(pairs(base, head)).toEqual([])
  })
})
