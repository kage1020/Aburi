import type { Effect, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { computeSymbolDelta } from "../src"
import { call, decorator, effect, fp, makeSymbol, rule } from "./fixtures"

/**
 * §5.2 pairs the elements of `rules`, `calls` and `decorators` by an identity key with a
 * ±`lineFuzz` tolerance on the line, so a cosmetic shift is not reported as a change. A key
 * does not identify one element — a Symbol routinely holds two `guard` rules, two calls to one
 * target, two `@Get` — so which base element a head element takes is a choice, and §5.2.0 is
 * where the rule for making it lives.
 *
 * The cases here are the ones that distinguish it from the near misses: pairing by array
 * order, pairing by proximity alone, and pairing greedily rather than as a set.
 */

const GUARD_PAIR = [
  rule({ type: "guard", line: 1, condition: "!user" }),
  rule({ type: "guard", line: 3, condition: "!invoice" }),
]

function withRules(rules: IRSymbol["rules"], seed: string): IRSymbol {
  return makeSymbol({ id: "ts:src/a.ts#handle", name: "handle", rules, fingerprint: fp(seed) })
}

/** `[added, removed, modified]` conditions, so a case reads as what the reviewer would see. */
function ruleDelta(base: IRSymbol["rules"], head: IRSymbol["rules"], lineFuzz = 2) {
  const delta = computeSymbolDelta(withRules(base, "a"), withRules(head, "b"), { lineFuzz })
  const conditions = (items: readonly unknown[] | undefined) =>
    (items ?? []).map((item) => (item as { condition: string | null }).condition)
  return {
    added: conditions(delta.rules?.added),
    removed: conditions(delta.rules?.removed),
    modified: conditions(delta.rules?.modified),
  }
}

describe("an element is paired with its own counterpart, not the nearest key", () => {
  it("reports the deleted guard, and only that", () => {
    expect(
      ruleDelta(GUARD_PAIR, [rule({ type: "guard", line: 3, condition: "!invoice" })]),
    ).toEqual({ added: [], removed: ["!user"], modified: [] })
  })

  it("does the same when the survivor is the first one", () => {
    expect(ruleDelta(GUARD_PAIR, [rule({ type: "guard", line: 1, condition: "!user" })])).toEqual({
      added: [],
      removed: ["!invoice"],
      modified: [],
    })
  })

  it("prefers the exact counterpart over a closer element of the same key", () => {
    // `!invoice` sits 2 lines away and `!user` 1 — nearest-line alone pairs the wrong one and
    // reports the untouched guard as modified.
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!invoice" }),
          rule({ type: "guard", line: 2, condition: "!user" }),
        ],
        [rule({ type: "guard", line: 3, condition: "!invoice" })],
      ),
    ).toEqual({ added: [], removed: ["!user"], modified: [] })
  })

  it("keeps a whole block of shifted rules quiet", () => {
    // Two guards moved down one line together, nothing edited. Every element has an exact
    // counterpart, so nothing is reported — this is what line fuzz is for.
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!a" }),
          rule({ type: "guard", line: 2, condition: "!b" }),
        ],
        [
          rule({ type: "guard", line: 2, condition: "!a" }),
          rule({ type: "guard", line: 3, condition: "!b" }),
        ],
      ),
    ).toEqual({ added: [], removed: [], modified: [] })
  })

  it("treats two guards that swapped places as unchanged", () => {
    // Both conditions are still present within the window, so there is nothing to report. By
    // array order or by proximity this reads as two edits.
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!a" }),
          rule({ type: "guard", line: 2, condition: "!b" }),
        ],
        [
          rule({ type: "guard", line: 1, condition: "!b" }),
          rule({ type: "guard", line: 2, condition: "!a" }),
        ],
      ),
    ).toEqual({ added: [], removed: [], modified: [] })
  })
})

describe("a genuine edit is still a modification", () => {
  it("reports an edited condition rather than an add and a remove", () => {
    expect(
      ruleDelta(
        [rule({ type: "guard", line: 1, condition: "!user" })],
        [rule({ type: "guard", line: 2, condition: "!admin" })],
      ),
    ).toEqual({ added: [], removed: [], modified: ["!admin"] })
  })

  it("edits the one guard that changed, leaving its neighbour alone", () => {
    // The exact pass takes `!invoice`, so the edit has only `!user` left to pair with — which
    // is the pairing a reader would make.
    expect(
      ruleDelta(GUARD_PAIR, [
        rule({ type: "guard", line: 1, condition: "!owner" }),
        rule({ type: "guard", line: 3, condition: "!invoice" }),
      ]),
    ).toEqual({ added: [], removed: [], modified: ["!owner"] })
  })

  it("still reports an add and a remove once the drift exceeds the window", () => {
    expect(
      ruleDelta(
        [rule({ type: "guard", line: 1, condition: "!user" })],
        [rule({ type: "guard", line: 40, condition: "!user" })],
      ),
    ).toEqual({ added: ["!user"], removed: ["!user"], modified: [] })
  })

  it("pairs strictly by line when fuzz is off", () => {
    expect(
      ruleDelta(GUARD_PAIR, [rule({ type: "guard", line: 3, condition: "!invoice" })], 0),
    ).toEqual({ added: [], removed: ["!user"], modified: [] })
  })
})

describe("the same rule applies to the other keyed arrays", () => {
  const symbolWith = (overrides: Partial<IRSymbol>, seed: string): IRSymbol =>
    makeSymbol({ id: "ts:src/a.ts#handle", name: "handle", fingerprint: fp(seed), ...overrides })

  it("calls: deleting the first of two to one target", () => {
    const delta = computeSymbolDelta(
      symbolWith(
        {
          calls: [
            call({ target: "log", line: 1, resolved: "ts:src/a.ts#debug" }),
            call({ target: "log", line: 3, resolved: "ts:src/a.ts#info" }),
          ],
        },
        "a",
      ),
      symbolWith({ calls: [call({ target: "log", line: 3, resolved: "ts:src/a.ts#info" })] }, "b"),
      { lineFuzz: 2 },
    )
    expect(delta.calls?.modified).toEqual([])
    expect(delta.calls?.added).toEqual([])
    expect(delta.calls?.removed?.map((c) => (c as { resolved: string }).resolved)).toEqual([
      "ts:src/a.ts#debug",
    ])
  })

  it("decorators: deleting the first of two with the same name", () => {
    const delta = computeSymbolDelta(
      symbolWith(
        {
          decorators: [
            decorator({ name: "Get", line: 1, arguments: ["/a"] }),
            decorator({ name: "Get", line: 3, arguments: ["/b"] }),
          ],
        },
        "a",
      ),
      symbolWith({ decorators: [decorator({ name: "Get", line: 3, arguments: ["/b"] })] }, "b"),
      { lineFuzz: 2 },
    )
    expect(delta.decorators?.modified).toEqual([])
    expect(delta.decorators?.added).toEqual([])
    expect(delta.decorators?.removed?.map((d) => (d as { arguments: string[] }).arguments)).toEqual(
      [["/a"]],
    )
  })
})

describe("pairings are chosen as a set, not one element at a time", () => {
  // A greedy pass takes the pairing in front of it, and a nearer pairing can cost a farther
  // one its only partner. Two identical guards shifted down together are the smallest case:
  // the first head guard is nearest the *second* base guard, and claiming it leaves the other
  // head outside the window entirely — a block that moved intact reported as an add and a
  // remove, which is precisely the noise line fuzz exists to suppress.

  it("keeps a block of identical rules quiet when it shifts", () => {
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!same" }),
          rule({ type: "guard", line: 2, condition: "!same" }),
        ],
        [
          rule({ type: "guard", line: 3, condition: "!same" }),
          rule({ type: "guard", line: 4, condition: "!same" }),
        ],
      ),
    ).toEqual({ added: [], removed: [], modified: [] })
  })

  it("does the same at the edge of the window", () => {
    // The shift is exactly `lineFuzz`, so every pairing that holds is at the boundary.
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!same" }),
          rule({ type: "guard", line: 2, condition: "!same" }),
        ],
        [
          rule({ type: "guard", line: 2, condition: "!same" }),
          rule({ type: "guard", line: 3, condition: "!same" }),
        ],
        1,
      ),
    ).toEqual({ added: [], removed: [], modified: [] })
  })

  it("reports two edits as two edits when both neighbours moved", () => {
    // Nothing survives the exact pass, so the whole block is the second pass's problem —
    // and the answer is still two modifications rather than an add, a remove and an edit.
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!first" }),
          rule({ type: "guard", line: 2, condition: "!second" }),
        ],
        [
          rule({ type: "guard", line: 3, condition: "!firstEdited" }),
          rule({ type: "guard", line: 4, condition: "!secondEdited" }),
        ],
      ),
    ).toEqual({ added: [], removed: [], modified: ["!firstEdited", "!secondEdited"] })
  })

  it("still separates a block that moved further than the window", () => {
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!same" }),
          rule({ type: "guard", line: 2, condition: "!same" }),
        ],
        [
          rule({ type: "guard", line: 40, condition: "!same" }),
          rule({ type: "guard", line: 41, condition: "!same" }),
        ],
      ),
    ).toEqual({ added: ["!same", "!same"], removed: ["!same", "!same"], modified: [] })
  })

  it("holds a block of identical calls to one target together", () => {
    const shifted = (lines: readonly number[]) =>
      lines.map((line) => call({ target: "logger.info", line }))
    const delta = computeSymbolDelta(
      makeSymbol({
        id: "ts:src/a.ts#handle",
        name: "handle",
        calls: shifted([1, 2]),
        fingerprint: fp("a"),
      }),
      makeSymbol({
        id: "ts:src/a.ts#handle",
        name: "handle",
        calls: shifted([3, 4]),
        fingerprint: fp("b"),
      }),
      { lineFuzz: 2 },
    )
    // Calling one function twice is ordinary, and `callsEqual` reads only `target` and
    // `resolved`, so identical duplicates are the common case rather than a contrived one.
    expect(delta.calls).toEqual({ added: [], removed: [], modified: [] })
  })

  it("holds a block of identical decorators together", () => {
    const stacked = (lines: readonly number[]) =>
      lines.map((line) => decorator({ name: "Roles", line, arguments: ["admin"] }))
    const delta = computeSymbolDelta(
      makeSymbol({
        id: "ts:src/a.ts#handle",
        name: "handle",
        decorators: stacked([1, 2]),
        fingerprint: fp("a"),
      }),
      makeSymbol({
        id: "ts:src/a.ts#handle",
        name: "handle",
        decorators: stacked([3, 4]),
        fingerprint: fp("b"),
      }),
      { lineFuzz: 2 },
    )
    expect(delta.decorators).toEqual({ added: [], removed: [], modified: [] })
  })

  it("reads the head elements as a set too, whatever order they are written in", () => {
    // One base guard and two head guards, only one of which can pair. Choosing per head
    // element in enumeration order let the first one written take the base regardless of
    // distance, so the answer followed the head array rather than the lines.
    const base = [rule({ type: "guard", line: 1, condition: "!original" })]
    const near = rule({ type: "guard", line: 1, condition: "!near" })
    const far = rule({ type: "guard", line: 3, condition: "!far" })
    expect(ruleDelta(base, [near, far])).toEqual({
      added: ["!far"],
      removed: [],
      modified: ["!near"],
    })
    expect(ruleDelta(base, [far, near])).toEqual({
      added: ["!far"],
      removed: [],
      modified: ["!near"],
    })
  })
})

describe("effects are paired under the same rule, with no line window", () => {
  // `diffEffects` passes an infinite fuzz, so every same-key candidate is admitted and only
  // the ranking is left. That ranking reads `line`, and a propagated effect has none —
  // `line ?? 0` stands in, which is "at the top of the Symbol" rather than a neutral value.

  const at = (plugin: string, line?: number) =>
    effect({
      id: "db.write",
      target: "prisma.user.create",
      plugin,
      ...(line === undefined ? {} : { line }),
    })

  const effectDelta = (base: Effect[], head: Effect[]) => {
    const delta = computeSymbolDelta(
      makeSymbol({ id: "ts:src/a.ts#f", name: "f", effects: base, fingerprint: fp("a") }),
      makeSymbol({ id: "ts:src/a.ts#f", name: "f", effects: head, fingerprint: fp("b") }),
    )
    const plugins = (items: readonly unknown[] | undefined) =>
      (items ?? []).map((item) => (item as { plugin: string | null }).plugin)
    return {
      added: plugins(delta.effects?.added),
      removed: plugins(delta.effects?.removed),
      modified: plugins(delta.effects?.modified),
    }
  }

  it("pairs an unchanged effect with itself however far its line moved", () => {
    expect(effectDelta([at("effects-prisma", 10)], [at("effects-prisma", 9000)])).toEqual({
      added: [],
      removed: [],
      modified: [],
    })
  })

  it("keeps two entries of one key apart by content rather than by line", () => {
    // Same `(id, target)` on both sides, so the key settles nothing. The exact-content pass
    // pairs each plugin with itself even though their lines crossed.
    expect(
      effectDelta(
        [at("effects-prisma", 1), at("effects-drizzle", 2)],
        [at("effects-drizzle", 1), at("effects-prisma", 2)],
      ),
    ).toEqual({ added: [], removed: [], modified: [] })
  })

  it("gives a propagated entry the nearest local one when it must choose", () => {
    // Nothing matches on content, so the placeholder line decides: `0` is nearest the local
    // effect at line 1. Documented rather than left to be discovered — a propagated effect
    // reads as sitting at the top of the Symbol.
    expect(effectDelta([at("far", 100), at("near", 1)], [at("propagated")])).toEqual({
      added: [],
      removed: ["far"],
      modified: ["propagated"],
    })
  })
})

describe("array order decides only where it has to", () => {
  // §3.8 makes Symbol pairing independent of array order, and an array delta cannot be: §5.2
  // pairs by line, and ir-schema §14 #11 fixes the canonical order of these arrays, so reading
  // it is reading the Document. What order must not decide is a pairing the lines already
  // settle — which is what taking the first key hit got wrong.
  it("answers the same with the base rules written the other way round", () => {
    const head = [rule({ type: "guard", line: 3, condition: "!invoice" })]
    expect(ruleDelta([...GUARD_PAIR].reverse(), head)).toEqual(ruleDelta(GUARD_PAIR, head))
  })

  it("answers the same with the head rules written the other way round", () => {
    const head = [
      rule({ type: "guard", line: 1, condition: "!owner" }),
      rule({ type: "guard", line: 3, condition: "!invoice" }),
    ]
    expect(ruleDelta(GUARD_PAIR, [...head].reverse())).toEqual(ruleDelta(GUARD_PAIR, head))
  })

  it("settles a tie on the lower base index", () => {
    // Two guards equidistant from one edited head guard, neither an exact match. Nothing
    // distinguishes them by line, so the lower index is taken and the other is removed — fixed
    // rather than left to the enumeration, and visible because their conditions differ.
    const equidistant = [
      rule({ type: "guard", line: 1, condition: "!first" }),
      rule({ type: "guard", line: 3, condition: "!second" }),
    ]
    const edited = [rule({ type: "guard", line: 2, condition: "!edited" })]
    expect(ruleDelta(equidistant, edited)).toEqual({
      added: [],
      removed: ["!second"],
      modified: ["!edited"],
    })
    // Reversing the base array swaps which is taken, and that is not a defect: unlike §3.8's
    // Symbol pairing, an array delta reads array order, which ir-schema §14 #11 fixes
    // canonically — so the reversed input below is not a conforming Document, and what is
    // asserted of it is only that the answer is determined. §3.7 records the distinction.
    const reversedBase = [...equidistant].reverse()
    expect(ruleDelta(reversedBase, edited)).toEqual(ruleDelta(reversedBase, edited))
    expect(ruleDelta(reversedBase, edited)).toEqual({
      added: [],
      removed: ["!first"],
      modified: ["!edited"],
    })
  })

  it("pairs an edit with the nearest candidate, not the first one written", () => {
    // Both survive the exact pass unclaimed, so the second pass decides. `!far@1` is written
    // first and `!near@3` is 0 lines away — taking the first hit would call `!far` the edit and
    // remove the guard that is still there.
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!far" }),
          rule({ type: "guard", line: 3, condition: "!near" }),
        ],
        [rule({ type: "guard", line: 3, condition: "!edited" })],
      ),
    ).toEqual({ added: [], removed: ["!far"], modified: ["!edited"] })
  })

  it("lets one base element answer only one head element", () => {
    // Two head guards, one base guard, both a line away. One is an addition rather than a
    // second claim on the same element, and which one is settled by §5.2.0's ordering rather
    // than by distance: the pairings may not cross, and the first head is above the second.
    expect(
      ruleDelta(
        [rule({ type: "guard", line: 2, condition: "!kept" })],
        [
          rule({ type: "guard", line: 1, condition: "!kept" }),
          rule({ type: "guard", line: 3, condition: "!added" }),
        ],
      ),
    ).toEqual({ added: ["!added"], removed: [], modified: [] })
  })
})
