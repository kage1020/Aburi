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

/**
 * Most of the cases above sit in a one-base bucket, where `reach` — which counts a base once
 * per shared token — already meets the bucket size and the whole-bucket fallback runs. These
 * are the ones wide enough that the postings walk is what answers, which is where the index
 * and its de-duplication stamp are observable at all.
 */
describe("the postings walk finds what the fallback would have", () => {
  /** Bases sharing no member token with anything else, to make a bucket too wide to fall back. */
  const filler = (count: number): IRSymbol[] =>
    Array.from({ length: count }, (_, i) => method(`src/f${i}.ts`, `Repo.zeta${i}Alpha`, `f${i}`))

  it("reaches a base whose shared tokens exclude its first", () => {
    // `{load, config, file, async}` against `{config, file, async}` — 3/4 = 0.75, a composite of
    // 0.875 over the 0.85 row. The head carries none of `load`, so a base indexed under its
    // first token alone is unreachable, and the bucket is too wide for the fallback to rescue
    // it. This is the shape a same-name pair cannot test, because that shares every token.
    const base = [...filler(8), method("src/a.ts", "Repo.loadConfigFileAsync", "a")]
    const head = [method("src/b.ts", "Repo.configFileAsync", "b")]
    expect(pairs(base, head)).toEqual(["Repo.loadConfigFileAsync -> Repo.configFileAsync"])
  })

  it("reaches a base whose shared tokens exclude the head's first", () => {
    // The mirror of the case above, and a separate skip: the head's postings are consulted in
    // its own token order, so a head that carries `load` where the base does not must still
    // find it through `config`.
    const base = [...filler(8), method("src/a.ts", "Repo.configFileAsync", "a")]
    const head = [method("src/b.ts", "Repo.loadConfigFileAsync", "b")]
    expect(pairs(base, head)).toEqual(["Repo.configFileAsync -> Repo.loadConfigFileAsync"])
  })

  it("keeps several heads apart through one bucket's stamp", () => {
    // Two heads walking the same postings lists in one pass, each reaching its base through
    // more than one token. The stamp is per bucket and advances per head, so a stale one would
    // make the second head skip a base the first had visited — a lost pairing, which is the
    // direction that shows. Counting a base twice does not: §3.8 claims each side once.
    const base = [
      ...filler(8),
      method("src/a1.ts", "Repo.loadConfigFile", "a1"),
      method("src/a2.ts", "Repo.parseHeaderValue", "a2"),
    ]
    const head = [
      method("src/b1.ts", "Repo.loadConfigFile", "b1"),
      method("src/b2.ts", "Repo.parseHeaderValue", "b2"),
    ]
    expect(pairs(base, head).sort()).toEqual([
      "Repo.loadConfigFile -> Repo.loadConfigFile",
      "Repo.parseHeaderValue -> Repo.parseHeaderValue",
    ])
  })

  it("pairs a bulk rename through the index rather than the fallback", () => {
    // The case the change exists for, padded so the bucket is wider than any head's reach.
    const members = ["loadConfigFile", "saveConfigFile", "resetConfigFile", "watchConfigFile"]
    const base = [
      ...filler(12),
      ...members.map((m, i) => method(`src/old/m${i}.ts`, `Store.${m}`, `a${i}`)),
    ]
    const head = members.map((m, i) => method(`src/new/m${i}.ts`, `Store.${m}`, `b${i}`))
    expect(pairs(base, head).sort()).toEqual(members.map((m) => `Store.${m} -> Store.${m}`).sort())
  })
})

describe("the shortcuts answer as the rule they stand in for", () => {
  // Reaching a base through several of its tokens, and answering §3.4.6's gate without running
  // it, are optimisations. Each has to give the answer the long way round gives, and these are
  // the shapes where a wrong shortcut is visible.

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

  it("pairs two top-level functions, which the identical-owner branch settles", () => {
    // Both owners extract to the empty string, so they are identical and the gate answers
    // there — the first-segment check and the matching are never reached.
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

describe("the fallback path answers a bulk rename the same way", () => {
  it("pairs every method of a renamed directory", () => {
    // A four-base bucket, so every head's reach meets it and the members are walked directly.
    // The indexed version of this is in the postings-walk block above.
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
