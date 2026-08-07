import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, writeCanonicalDiff } from "../src"
import { fp, makeIR, makeSymbol, sig, zeroFp } from "./fixtures"

/**
 * Two properties the matcher owes its callers, neither of which it held.
 *
 * **The answer does not depend on the order of the input arrays.** Stages 2 to 4.5 all
 * resolved ties by whichever candidate came first, so permuting `symbols[]` changed the
 * canonical bytes of the diff. `scan` happens to emit id-sorted symbols, but `buildDiff` is
 * public API and stage 3 hands stage 4 a `remainingBase` reordered by bucket insertion, so
 * even the CLI path did not reach stage 4 in id order.
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
    change.status === "added" || change.status === "removed"
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
    // Two bases and two heads on one fingerprint. Only one pairing clears 0.85; today the
    // bucket shrinks to a single candidate and the remaining head pairs unconditionally, and
    // that has to survive the change from per-head greedy to a scored sweep.
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

describe("stage 4.5 does not depend on input order", () => {
  it("resolves a tie to the lower base id", () => {
    // Both bases score 0.5 — the trailing name segment hits, the file basename does not.
    const head = () => [dropped("src/mid/Order.ts", "Svc.handle")]
    const a = () => dropped("src/aaa/Alpha.ts", "Svc.handle")
    const z = () => dropped("src/zzz/Zeta.ts", "Svc.handle")
    const expected = ["moved ts:src/aaa/Alpha.ts#Svc.handle -> ts:src/mid/Order.ts#Svc.handle"]
    expect(changes([a(), z()], head())).toEqual(expected)
    expect(changes([z(), a()], head())).toEqual(expected)
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
        change.status === "added" || change.status === "removed"
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
