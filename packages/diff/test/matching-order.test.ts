import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  buildDiff,
  matchStageDroppedWeak,
  matchStageGitRename,
  matchStageLogicFingerprint,
  matchStageNameSignature,
  writeCanonicalDiff,
} from "../src"
import { fp, makeIR, makeSymbol, sig, zeroFp } from "./fixtures"

/**
 * Two properties the matcher owes its callers, neither of which it held.
 *
 * **The answer does not depend on the order of the input arrays.** Stages 2 to 4.5 all
 * resolved ties by whichever candidate came first, so permuting `symbols[]` changed the
 * canonical bytes of the diff. `scan` emits id-sorted symbols, which was no protection:
 * `buildDiff` is public API, and stage 3 used to rebuild `remainingBase` in
 * fingerprint-bucket order, so even the CLI path did not reach stage 4 in id order.
 *
 * **A better pair is not discarded for a worse one.** Stages 3 and 4 consumed a base the
 * moment some head wanted it, so an earlier head could take a base that was a later head's
 * exact match — putting one name in the output as both `added` and a move source.
 *
 * The tie-break is `(base.id, head.id)` ascending, which is a total order only because ids
 * are unique within a Document (ir-schema.md §14 #1) and `buildDiff` establishes that before
 * the first stage runs.
 */

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

/** Every change as `status base -> head`, in the diff's own canonical order. */
function changes(baseSymbols: IRSymbol[], headSymbols: IRSymbol[]): string[] {
  const diff = buildDiff({
    baseIR: makeIR({ symbols: baseSymbols }),
    headIR: makeIR({ symbols: headSymbols }),
    base: IR_REF,
    head: IR_REF,
  })
  return diff.symbols.map((change) =>
    change.status === "added" || change.status === "removed" || change.status === "unknown"
      ? `${change.status} ${change.symbol.id}`
      : `${change.status} ${change.before.id} -> ${change.after.id}`,
  )
}

/** A callable symbol, so stage 4 has a signature to score. */
function method(file: string, name: string, seed: string): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind: "method",
    fingerprint: fp(seed),
    signature: sig({ inputs: [{ name: "x", type: "string" }], outputs: ["User"] }),
  })
}

/** A symbol carrying an explicit logic fingerprint, for the stage-3 cases. */
function withLogic(file: string, name: string, logic: string): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind: "method",
    fingerprint: { api: "aaaaaaaaaaaa", logic, syntax: "bbbbbbbbbbbb" },
    signature: sig(),
  })
}

function dropped(file: string, name: string): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind: "method",
    dropped: true,
    dropReason: "size",
    fingerprint: zeroFp(),
  })
}

describe("stage 4 keeps the better pair", () => {
  // Scores for these four names, with identical signatures and owners:
  //   ByEmailAddress x ByEmailAddress = 1.0000   <- the optimum
  //   ByEmailAddress x ByEmail        = 0.9167
  //   ById           x ByEmail        = 0.8333   (below the 0.85 threshold)
  //   ById           x ByEmailAddress = 0.7857
  const base = () => [
    method("src/r.ts", "Repo.findUserById", "a"),
    method("src/r.ts", "Repo.findUserByEmailAddress", "b"),
  ]
  const head = () => [
    method("src/q.ts", "Repo.findUserByEmail", "c"),
    method("src/q.ts", "Repo.findUserByEmailAddress", "d"),
  ]

  it("pairs the exact match rather than letting an earlier head consume it", () => {
    // Head-driven greedy took `findUserByEmail` first — it sorts earlier — and consumed the
    // base `findUserByEmailAddress` at 0.9167, leaving the head of the same name with only
    // `findUserById` at 0.7857 and reporting it as `added`.
    expect(changes(base(), head())).toEqual([
      "added ts:src/q.ts#Repo.findUserByEmail",
      "moved+changed ts:src/r.ts#Repo.findUserByEmailAddress -> ts:src/q.ts#Repo.findUserByEmailAddress",
      "removed ts:src/r.ts#Repo.findUserById",
    ])
  })

  it("does not report one qualified name as both added and a move source", () => {
    // The symptom that makes the loss visible in a review: `Repo.findUserByEmailAddress`
    // appeared as an addition and as the source of a move at the same time.
    const roles = new Map<string, Set<string>>()
    for (const line of changes(base(), head())) {
      const [status, ...ids] = line.split(" ")
      const endpoints = status === "added" || status === "removed" ? [ids[0]] : [ids[0], ids[2]]
      for (const id of endpoints) {
        const name = (id as string).split("#")[1] as string
        const seen = roles.get(name) ?? new Set<string>()
        seen.add(status as string)
        roles.set(name, seen)
      }
    }
    const contradictory = [...roles].filter(
      ([, statuses]) => statuses.has("added") && statuses.size > 1,
    )
    expect(contradictory).toEqual([])
  })
})

describe("stage 4 does not depend on input order", () => {
  const head = () => [method("src/mid.ts", "Alpha.createOrderRecord", "z")]
  const first = () => method("src/aaa.ts", "Alpha.createOrderRecord", "p")
  const second = () => method("src/zzz.ts", "Alpha.createOrderRecord", "q")

  it("resolves a tie to the lower base id, whichever way the array is written", () => {
    const expected = [
      "moved+changed ts:src/aaa.ts#Alpha.createOrderRecord -> ts:src/mid.ts#Alpha.createOrderRecord",
      "removed ts:src/zzz.ts#Alpha.createOrderRecord",
    ]
    expect(changes([first(), second()], head())).toEqual(expected)
    expect(changes([second(), first()], head())).toEqual(expected)
  })

  it("resolves a tie to the lower head id, whichever way the array is written", () => {
    const base = () => [method("src/mid.ts", "Alpha.createOrderRecord", "z")]
    const a = () => method("src/aaa.ts", "Alpha.createOrderRecord", "p")
    const z = () => method("src/zzz.ts", "Alpha.createOrderRecord", "q")
    const expected = [
      "added ts:src/zzz.ts#Alpha.createOrderRecord",
      "moved+changed ts:src/mid.ts#Alpha.createOrderRecord -> ts:src/aaa.ts#Alpha.createOrderRecord",
    ]
    expect(changes(base(), [a(), z()])).toEqual(expected)
    expect(changes(base(), [z(), a()])).toEqual(expected)
  })

  it("prefers the higher score over the lower id", () => {
    // The tie-break is only reached at equal scores: a lower-id candidate that scores worse
    // must still lose, or the sort has the two keys the wrong way round.
    const bases = [
      method("src/aaa.ts", "Alpha.createInvoiceRecord", "p"),
      method("src/zzz.ts", "Alpha.createOrderRecord", "q"),
    ]
    expect(changes(bases, head())).toEqual([
      "moved+changed ts:src/zzz.ts#Alpha.createOrderRecord -> ts:src/mid.ts#Alpha.createOrderRecord",
      "removed ts:src/aaa.ts#Alpha.createInvoiceRecord",
    ])
  })
})

describe("stage 4 thresholds are unchanged", () => {
  it("still refuses a pair below the head's threshold", () => {
    // `getUser` vs `getUsers`: two tokens, so the threshold is 0.95 and the pair is refused —
    // §3.4.3's worked example, which the reordering must not weaken.
    const changed = changes(
      [method("src/a.ts", "Repo.getUser", "a")],
      [method("src/b.ts", "Repo.getUsers", "b")],
    )
    expect(changed).toEqual(["added ts:src/b.ts#Repo.getUsers", "removed ts:src/a.ts#Repo.getUser"])
  })

  it("still refuses a signature-less head", () => {
    // §3.4.3 tail: `null + null` scores 1.0 on the signature axis and would flood the bucket.
    const noSig = (file: string, name: string, seed: string) =>
      makeSymbol({ id: `ts:${file}#${name}`, name, kind: "class", fingerprint: fp(seed) })
    const changed = changes(
      [noSig("src/a.ts", "OrderService", "a")],
      [noSig("src/b.ts", "OrderService", "b")],
    )
    expect(changed).toEqual(["added ts:src/b.ts#OrderService", "removed ts:src/a.ts#OrderService"])
  })
})

describe("stage 3 disambiguation does not depend on input order", () => {
  it("picks the higher name similarity, whichever way the array is written", () => {
    const head = () => [withLogic("src/mid.ts", "Svc.createOrder", "111111111111")]
    const match = () => withLogic("src/zzz.ts", "Svc.createOrder", "111111111111")
    const other = () => withLogic("src/aaa.ts", "Svc.deleteInvoice", "111111111111")
    const expected = [
      "moved ts:src/zzz.ts#Svc.createOrder -> ts:src/mid.ts#Svc.createOrder",
      "removed ts:src/aaa.ts#Svc.deleteInvoice",
    ]
    expect(changes([match(), other()], head())).toEqual(expected)
    expect(changes([other(), match()], head())).toEqual(expected)
  })

  it("resolves an exact tie to the lower base id", () => {
    const head = () => [withLogic("src/mid.ts", "Svc.createOrder", "111111111111")]
    const a = () => withLogic("src/aaa.ts", "Svc.createOrder", "111111111111")
    const z = () => withLogic("src/zzz.ts", "Svc.createOrder", "111111111111")
    const expected = [
      "moved ts:src/aaa.ts#Svc.createOrder -> ts:src/mid.ts#Svc.createOrder",
      "removed ts:src/zzz.ts#Svc.createOrder",
    ]
    expect(changes([a(), z()], head())).toEqual(expected)
    expect(changes([z(), a()], head())).toEqual(expected)
  })
})

describe("stage 3 keeps its unconditional single-candidate branch", () => {
  it("pairs one base with one head however unlike their names are", () => {
    // §3.3: a lone candidate pairs with no similarity test at all. The reordering must not
    // quietly introduce the 0.85 threshold here.
    const changed = changes(
      [withLogic("src/a.ts", "Svc.alpha", "111111111111")],
      [withLogic("src/b.ts", "Other.omega", "111111111111")],
    )
    expect(changed).toEqual(["moved ts:src/a.ts#Svc.alpha -> ts:src/b.ts#Other.omega"])
  })

  it("pairs exactly one of two heads, and the same one under either order", () => {
    const base = () => [withLogic("src/a.ts", "Svc.createOrder", "111111111111")]
    const near = () => withLogic("src/b.ts", "Svc.createOrder", "111111111111")
    const far = () => withLogic("src/c.ts", "Other.omega", "111111111111")
    const expected = [
      "added ts:src/c.ts#Other.omega",
      "moved ts:src/a.ts#Svc.createOrder -> ts:src/b.ts#Svc.createOrder",
    ]
    expect(changes(base(), [near(), far()])).toEqual(expected)
    expect(changes(base(), [far(), near()])).toEqual(expected)
  })

  it("still cascades: the pair left over after a scored match pairs unconditionally", () => {
    // Two bases and two heads on one fingerprint, of which only one pairing clears 0.85.
    // §3.3 pairs the leftovers anyway: once a round leaves a single base, it is the lone
    // candidate and the branch above applies. Both pair, and neither similarity is tested.
    const base = [
      withLogic("src/a.ts", "Svc.createOrder", "111111111111"),
      withLogic("src/b.ts", "Svc.zzz", "111111111111"),
    ]
    const head = [
      withLogic("src/c.ts", "Svc.createOrder", "111111111111"),
      withLogic("src/d.ts", "Svc.qqq", "111111111111"),
    ]
    expect(changes(base, head)).toEqual([
      "moved ts:src/a.ts#Svc.createOrder -> ts:src/c.ts#Svc.createOrder",
      "moved ts:src/b.ts#Svc.zzz -> ts:src/d.ts#Svc.qqq",
    ])
  })
})

describe("the thresholds moved into the candidate filter still hold", () => {
  it("stage 3 leaves a group whose names cannot reach 0.85", () => {
    // Two bases and one head on one fingerprint, so the lone-candidate branch does not apply
    // and the 0.85 test is the only thing standing between them. All three are
    // signature-less, which keeps stage 4 out of it (§3.4.3 tail) and makes the outcome
    // stage 3's alone.
    const body = (file: string, name: string) =>
      makeSymbol({
        id: `ts:${file}#${name}`,
        name,
        kind: "class",
        fingerprint: { api: "aaaaaaaaaaaa", logic: "222222222222", syntax: "bbbbbbbbbbbb" },
      })
    expect(
      changes([body("src/a.ts", "Alpha"), body("src/b.ts", "Beta")], [body("src/c.ts", "Gamma")]),
    ).toEqual(["added ts:src/c.ts#Gamma", "removed ts:src/a.ts#Alpha", "removed ts:src/b.ts#Beta"])
  })

  it("stage 4.5 refuses a pair that hits neither the name nor the basename", () => {
    // §3.4.5 accepts a one-sided hit and nothing less. With the threshold gone every dropped
    // symbol of the same kind becomes a candidate, and the sweep pairs them at score 0.
    const diff = buildDiff({
      baseIR: makeIR({ symbols: [dropped("src/a/One.ts", "Svc.alpha")] }),
      headIR: makeIR({ symbols: [dropped("src/b/Two.ts", "Svc.beta")] }),
      base: IR_REF,
      head: IR_REF,
    })
    expect(diff.symbols).toEqual([])
    expect(diff.summary.droppedAdded).toBe(1)
    expect(diff.summary.droppedRemoved).toBe(1)
    expect(diff.summary.moved).toBe(0)
  })
})

describe("stage 4.5 against a direct reading of §3.4.5", () => {
  // Checking the stage against a second implementation of the same algorithm proves only
  // that it was written twice. These are the three things §3.4.5 actually claims, each
  // established by something structurally unlike the code under test: the candidates come
  // from a brute-force cross-product, and the size they can reach comes from Kuhn’s
  // augmenting-path search rather than a component walk.

  /** Every pairing §3.4.5 identifies, from the cross-product rather than from a lookup. */
  function identifiedPairings(base: IRSymbol[], head: IRSymbol[]): [string, string][] {
    const droppedBase = base.filter((s) => s.dropped)
    const droppedHead = head.filter((s) => s.dropped)
    const last = (s: IRSymbol) => `${s.kind}/${s.name.slice(s.name.lastIndexOf(".") + 1)}`
    const file = (s: IRSymbol) =>
      `${s.kind}/${s.source.file.slice(s.source.file.lastIndexOf("/") + 1)}`
    const carriedOnce = (symbols: IRSymbol[], keyOf: (s: IRSymbol) => string, key: string) =>
      symbols.filter((s) => keyOf(s) === key).length === 1

    const pairings: [string, string][] = []
    for (const h of droppedHead) {
      for (const b of droppedBase) {
        const identifies = [last, file].some(
          (keyOf) =>
            keyOf(b) === keyOf(h) &&
            carriedOnce(droppedBase, keyOf, keyOf(b)) &&
            carriedOnce(droppedHead, keyOf, keyOf(h)),
        )
        if (identifies) pairings.push([b.id, h.id])
      }
    }
    return pairings
  }

  /** Kuhn’s augmenting-path search — how many of them can hold at once. */
  function maximumSize(pairings: readonly [string, string][]): number {
    const headsFor = new Map<string, string[]>()
    for (const [baseId, headId] of pairings) {
      const bucket = headsFor.get(baseId)
      if (bucket === undefined) headsFor.set(baseId, [headId])
      else bucket.push(headId)
    }
    const takenBy = new Map<string, string>()
    const augment = (baseId: string, tried: Set<string>): boolean => {
      for (const headId of headsFor.get(baseId) ?? []) {
        if (tried.has(headId)) continue
        tried.add(headId)
        const holder = takenBy.get(headId)
        if (holder === undefined || augment(holder, tried)) {
          takenBy.set(headId, baseId)
          return true
        }
      }
      return false
    }
    let size = 0
    for (const baseId of headsFor.keys()) {
      if (augment(baseId, new Set())) size++
    }
    return size
  }

  /** Deterministic pseudo-randomness: the same corpus on every machine and every run. */
  function generator(seed: number): () => number {
    let state = seed
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
  }

  const names = ["Svc.alpha", "Svc.beta", "Other.alpha", "gamma"]
  const files = ["src/a/index.ts", "src/b/index.ts", "src/a/Dto.ts", "src/c/Other.ts"]
  const kinds = ["class", "method"] as const

  function corpora(): { base: IRSymbol[]; head: IRSymbol[] }[] {
    return Array.from({ length: 40 }, (_, corpus) => {
      const next = generator(corpus * 7919 + 13)
      const build = (side: string, count: number) =>
        Array.from({ length: count }, (_, i) => {
          const file = files[Math.floor(next() * files.length)] as string
          const name = names[Math.floor(next() * names.length)] as string
          return makeSymbol({
            id: `ts:${side}/${i}/${file}#${name}`,
            name,
            kind: kinds[Math.floor(next() * kinds.length)] ?? "class",
            dropped: next() < 0.85,
            dropReason: "size",
            fingerprint: zeroFp(),
            source: { file: `${side}/${i}/${file}`, startLine: 1, endLine: 2 },
          })
        })
      return {
        base: build("base", 1 + Math.floor(next() * 8)),
        head: build("head", 1 + Math.floor(next() * 8)),
      }
    })
  }

  it("pairs only Symbols §3.4.5 identifies, and each at most once", () => {
    for (const { base, head } of corpora()) {
      const { matched } = matchStageDroppedWeak(base, head)
      const identified = new Set(identifiedPairings(base, head).map(([b, h]) => `${b} ${h}`))
      expect(matched.filter((p) => !identified.has(`${p.base.id} ${p.head.id}`))).toEqual([])
      expect(new Set(matched.map((p) => p.base.id)).size).toBe(matched.length)
      expect(new Set(matched.map((p) => p.head.id)).size).toBe(matched.length)
    }
  })

  it("pairs as many as can hold at once", () => {
    // The property the component walk exists for. A sweep that settles conflicts by id
    // satisfies every other assertion in this file and fails this one.
    for (const { base, head } of corpora()) {
      const { matched } = matchStageDroppedWeak(base, head)
      expect(matched.length).toBe(maximumSize(identifiedPairings(base, head)))
    }
  })

  it("answers the same however the arrays are ordered, and hands on the rest in order", () => {
    for (const { base, head } of corpora()) {
      const actual = matchStageDroppedWeak(base, head)
      const shown = (pairs: typeof actual.matched) =>
        pairs.map((p) => `${p.base.id} -> ${p.head.id}`).sort()
      expect(
        shown(matchStageDroppedWeak([...base].reverse(), [...head].reverse()).matched),
      ).toEqual(shown(actual.matched))
      const claimedBase = new Set(actual.matched.map((p) => p.base.id))
      const claimedHead = new Set(actual.matched.map((p) => p.head.id))
      expect(actual.remainingBase).toEqual(base.filter((s) => !claimedBase.has(s.id)))
      expect(actual.remainingHead).toEqual(head.filter((s) => !claimedHead.has(s.id)))
    }
  })
})

describe("stage 4.5 does not depend on input order", () => {
  it("resolves a tie to the lower base id", () => {
    // Two bases identified by different halves of §3.4.5's score, both offering the same
    // head: `Svc.handle` by the trailing name segment, `Shared.ts` by the file basename.
    // Every candidate carries the same weight there, so the id keys decide.
    const head = () => [dropped("src/mid/Shared.ts", "Svc.handle")]
    const a = () => dropped("src/aaa/Alpha.ts", "Svc.handle")
    const z = () => dropped("src/zzz/Shared.ts", "Svc.other")
    const expected = ["moved ts:src/aaa/Alpha.ts#Svc.handle -> ts:src/mid/Shared.ts#Svc.handle"]
    expect(changes([a(), z()], head())).toEqual(expected)
    expect(changes([z(), a()], head())).toEqual(expected)
  })
})

describe("every stage hands on what it did not claim, in the caller's order", () => {
  // `buildDiff` sorts `symbols[]` at the end, so a stage that rebuilt its leftovers in some
  // other order would be invisible through it — and stage 3 did exactly that, handing stage 4
  // a `remainingBase` in fingerprint-bucket order. These call the stages directly.
  const symbols = [
    method("src/z.ts", "Svc.zeta", "z"),
    method("src/a.ts", "Svc.alpha", "a"),
    method("src/m.ts", "Svc.mu", "m"),
  ]

  it("stage 2 with no rename map", () => {
    const result = matchStageGitRename(symbols, symbols, null)
    expect(result.remainingBase).toEqual(symbols)
    expect(result.remainingHead).toEqual(symbols)
  })

  it("stage 3 with nothing to pair", () => {
    const heads = [method("src/q.ts", "Svc.qoppa", "q")]
    const result = matchStageLogicFingerprint(symbols, heads)
    expect(result.remainingBase).toEqual(symbols)
    expect(result.remainingHead).toEqual(heads)
  })

  it("stage 3 keeps the order of what it did not pair", () => {
    // One head shares `src/m.ts`'s fingerprint, so `Svc.mu` is claimed and the other two come
    // back in the order they went in — not grouped by fingerprint.
    const heads = [method("src/n.ts", "Svc.mu", "m")]
    const result = matchStageLogicFingerprint(symbols, heads)
    expect(result.matched).toHaveLength(1)
    expect(result.remainingBase.map((s) => s.id)).toEqual([
      "ts:src/z.ts#Svc.zeta",
      "ts:src/a.ts#Svc.alpha",
    ])
  })

  it("stage 4 keeps the order of what it did not pair", () => {
    const heads = [method("src/n.ts", "Svc.alpha", "n")]
    const result = matchStageNameSignature(symbols, heads)
    expect(result.matched).toHaveLength(1)
    expect(result.remainingBase.map((s) => s.id)).toEqual([
      "ts:src/z.ts#Svc.zeta",
      "ts:src/m.ts#Svc.mu",
    ])
  })

  it("stage 4.5 does not move non-dropped symbols to the front", () => {
    const mixed = [
      method("src/z.ts", "Svc.zeta", "z"),
      dropped("src/a/Dto.ts", "Svc.alpha"),
      method("src/m.ts", "Svc.mu", "m"),
    ]
    const result = matchStageDroppedWeak(mixed, [])
    expect(result.remainingBase).toEqual(mixed)
  })
})

describe("stage 2 does not depend on input order", () => {
  it("resolves two renames onto one target to the lower base id", () => {
    const renamed = (file: string, seed: string) =>
      makeSymbol({ id: `ts:${file}#foo`, name: "foo", fingerprint: fp(seed) })
    const gitRenames = new Map([
      ["src/aaa.ts", "src/c.ts"],
      ["src/zzz.ts", "src/c.ts"],
    ])
    const run = (symbols: IRSymbol[]) =>
      buildDiff({
        baseIR: makeIR({ symbols }),
        headIR: makeIR({ symbols: [renamed("src/c.ts", "c")] }),
        base: IR_REF,
        head: IR_REF,
        gitRenames,
      }).symbols.map((change) =>
        change.status === "added" || change.status === "removed" || change.status === "unknown"
          ? `${change.status} ${change.symbol.id}`
          : `${change.status} ${change.before.id} -> ${change.after.id}`,
      )
    const a = renamed("src/aaa.ts", "a")
    const z = renamed("src/zzz.ts", "z")
    const expected = [
      "moved+changed ts:src/aaa.ts#foo -> ts:src/c.ts#foo",
      "removed ts:src/zzz.ts#foo",
    ]
    expect(run([a, z])).toEqual(expected)
    expect(run([z, a])).toEqual(expected)
  })

  it("leaves a base whose predicted id the grammar cannot express", () => {
    // The rewriter goes back through the id constructor rather than concatenating, so a
    // rename target the grammar rejects yields no prediction at all. That has to read as a
    // lookup miss — minting an id no head can equal would be worse than not guessing.
    const base = makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("a") })
    const head = makeSymbol({ id: "ts:src/b.ts#foo", name: "foo", fingerprint: fp("b") })
    const result = matchStageGitRename([base], [head], new Map([["src/a.ts", "..\\out\\b.ts"]]))
    expect(result.matched).toEqual([])
    expect(result.remainingBase).toEqual([base])
    expect(result.remainingHead).toEqual([head])
  })
})

describe("the diff is a function of the two Documents, not of their array order", () => {
  // The measurement behind this: shuffling the input arrays changed the canonical bytes in
  // 207 of 400 randomised cases. One deterministic sweep over the permutations of a fixture
  // built entirely out of ties is a sharper version of the same check.
  // Three bases and three heads under one name: every one of the nine scores is 1.0, so the
  // pairing is decided by the tie-break alone. A fixture of *distinct* names would not test
  // anything — each head's exact match already wins on score.
  const files = ["aaa", "mmm", "zzz"]

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]]
    const out: T[][] = []
    for (const [index, item] of items.entries()) {
      const rest = [...items.slice(0, index), ...items.slice(index + 1)]
      for (const tail of permutations(rest)) out.push([item, ...tail])
    }
    return out
  }

  it("produces identical canonical bytes for every permutation of both sides", () => {
    // Distinct fingerprints on every symbol, so stage 3 resolves none of them and all nine
    // pairings are stage 4's to decide.
    const base = files.map((f) => method(`src/base/${f}.ts`, "Svc.createOrderRecord", `b${f}`))
    const head = files.map((f) => method(`src/head/${f}.ts`, "Svc.createOrderRecord", `h${f}`))
    const canonical = new Set<string>()
    for (const baseOrder of permutations(base)) {
      for (const headOrder of permutations(head)) {
        canonical.add(
          writeCanonicalDiff(
            buildDiff({
              baseIR: makeIR({ symbols: baseOrder }),
              headIR: makeIR({ symbols: headOrder }),
              base: IR_REF,
              head: IR_REF,
            }),
          ),
        )
      }
    }
    expect(canonical.size).toBe(1)
  })

  it("reports nothing when a Document is diffed against itself", () => {
    const symbols = files.map((file) => method(`src/base/${file}.ts`, `Svc.${file}Record`, file))
    const ir: IR = makeIR({ symbols })
    const diff = buildDiff({ baseIR: ir, headIR: ir, base: IR_REF, head: IR_REF })
    expect(diff.symbols).toEqual([])
    expect(diff.summary.unchanged).toBe(symbols.length)
  })
})
