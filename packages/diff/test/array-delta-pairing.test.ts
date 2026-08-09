import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { computeSymbolDelta } from "../src"
import { call, decorator, fp, makeSymbol, rule } from "./fixtures"

/**
 * §5.2 pairs the elements of `rules`, `calls` and `decorators` by an identity key with a
 * ±`lineFuzz` tolerance on the line, so a cosmetic shift is not reported as a change. Several
 * elements of one Symbol routinely share a key — two `guard` rules, two calls to one target,
 * two `@Get` — so which base element a head element takes is a real choice, and it was being
 * made by base array order.
 *
 * Deleting the first of two guards two lines apart:
 *
 * ```
 * base  guard@1 "!user"   guard@3 "!invoice"
 * head                    guard@3 "!invoice"
 * ```
 *
 * The surviving guard took `guard@1` — the first key hit inside the window — and was reported
 * as `removed` and `modified` at once, under its own head content. The guard that was actually
 * deleted appeared nowhere.
 *
 * Two passes fix it. Elements whose key *and content* agree are paired first, nearest line
 * first, so an untouched element is claimed by its own counterpart before anything else can
 * take it; what is left is then paired by nearest line, which is where a genuine edit lands.
 *
 * Nearest-line alone is not enough, and gets two of the cases below wrong: it pairs by
 * proximity even when an exact counterpart sits one line further away, so a two-element shift
 * comes back as two `modified` entries — the noise line fuzz exists to suppress.
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
    // Reversing the base array *does* swap which is taken, and that is not a defect: unlike
    // §3.8's Symbol pairing, an array delta reads array order, which ir-schema §14 #11 fixes
    // canonically. §3.7 records the distinction. What the tie-break buys is that the answer
    // follows the order the IR states rather than the order the loop happens to enumerate.
    expect(ruleDelta([...equidistant].reverse(), edited)).toEqual({
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
    // Two head guards, one base guard, all within the window. The nearer head takes it; the
    // other is an addition rather than a second claim on the same element.
    expect(
      ruleDelta(
        [rule({ type: "guard", line: 2, condition: "!user" })],
        [
          rule({ type: "guard", line: 1, condition: "!user" }),
          rule({ type: "guard", line: 3, condition: "!user" }),
        ],
      ),
    ).toEqual({ added: ["!user"], removed: [], modified: [] })
  })
})
