import { call, decorator, effect, fp, makeSymbol, rule } from "@aburi/test-support"
import type { Effect, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { computeSymbolDelta } from "../src"

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
    expect(
      ruleDelta(GUARD_PAIR, [
        rule({ type: "guard", line: 1, condition: "!owner" }),
        rule({ type: "guard", line: 3, condition: "!invoice" }),
      ]),
    ).toEqual({ added: [], removed: [], modified: ["!owner"] })
  })

  it("reports an add and a remove once an edit drifts past the window", () => {
    expect(
      ruleDelta(
        [rule({ type: "guard", line: 1, condition: "!user" })],
        [rule({ type: "guard", line: 40, condition: "!admin" })],
      ),
    ).toEqual({ added: ["!admin"], removed: ["!user"], modified: [] })
  })

  it("refuses an edit one line past the window", () => {
    // Δ = 3 = the default fuzz + 1: the rejecting side of the window's boundary.
    expect(
      ruleDelta(
        [rule({ type: "guard", line: 1, condition: "!user" })],
        [rule({ type: "guard", line: 4, condition: "!admin" })],
      ),
    ).toEqual({ added: ["!admin"], removed: ["!user"], modified: [] })
  })

  it("pairs strictly by line when fuzz is off", () => {
    expect(
      ruleDelta(GUARD_PAIR, [rule({ type: "guard", line: 3, condition: "!invoice" })], 0),
    ).toEqual({ added: [], removed: ["!user"], modified: [] })
  })
})

describe("an unchanged element pairs however far the body moved", () => {
  it.each([0, 2, 10])("keeps a moved rule quiet at lineFuzz=%i", (lineFuzz) => {
    expect(
      ruleDelta(
        [rule({ type: "guard", line: 1, condition: "!user" })],
        [rule({ type: "guard", line: 40, condition: "!user" })],
        lineFuzz,
      ),
    ).toEqual({ added: [], removed: [], modified: [] })
  })

  it("keeps the calls of a function that moved 14 lines down its file quiet", () => {
    const calls = (at: number) => [
      call({ target: "dirname", line: at }),
      call({ target: "mkdir", line: at }),
      call({ target: "writeFile", line: at + 1 }),
    ]
    const delta = computeSymbolDelta(
      makeSymbol({
        id: "ts:src/a.ts#writeOutputFile",
        name: "writeOutputFile",
        calls: calls(32),
        fingerprint: fp("a"),
      }),
      makeSymbol({
        id: "ts:src/a.ts#writeOutputFile",
        name: "writeOutputFile",
        calls: calls(46),
        fingerprint: fp("b"),
      }),
    )
    expect(delta.calls).toEqual({ added: [], removed: [], modified: [] })
  })

  it("keeps a moved decorator quiet", () => {
    const at = (line: number) => [decorator({ name: "Get", line, arguments: ["/a"] })]
    const delta = computeSymbolDelta(
      makeSymbol({
        id: "ts:src/a.ts#handle",
        name: "handle",
        decorators: at(3),
        fingerprint: fp("a"),
      }),
      makeSymbol({
        id: "ts:src/a.ts#handle",
        name: "handle",
        decorators: at(30),
        fingerprint: fp("b"),
      }),
    )
    expect(delta.decorators).toEqual({ added: [], removed: [], modified: [] })
  })

  it("pairs the survivors of a moved body and reports only what was edited", () => {
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!user" }),
          rule({ type: "guard", line: 2, condition: "!owner" }),
          rule({ type: "guard", line: 3, condition: "!invoice" }),
        ],
        [
          rule({ type: "guard", line: 21, condition: "!user" }),
          rule({ type: "guard", line: 22, condition: "!admin" }),
          rule({ type: "guard", line: 23, condition: "!invoice" }),
        ],
      ),
    ).toEqual({ added: ["!admin"], removed: ["!owner"], modified: [] })
  })

  it("pairs a call that moved past a call to a different target", () => {
    const delta = computeSymbolDelta(
      makeSymbol({
        id: "ts:src/a.ts#run",
        name: "run",
        calls: [call({ target: "scan", line: 10 }), call({ target: "mkdir", line: 14 })],
        fingerprint: fp("a"),
      }),
      makeSymbol({
        id: "ts:src/a.ts#run",
        name: "run",
        calls: [call({ target: "mkdir", line: 12 }), call({ target: "scan", line: 30 })],
        fingerprint: fp("b"),
      }),
    )
    expect(delta.calls).toEqual({ added: [], removed: [], modified: [] })
  })

  it("still refuses an element that moved past a sibling sharing its key", () => {
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!a" }),
          rule({ type: "guard", line: 2, condition: "!b" }),
        ],
        [
          rule({ type: "guard", line: 1, condition: "!b" }),
          rule({ type: "guard", line: 31, condition: "!a" }),
        ],
      ),
    ).toEqual({ added: ["!a"], removed: ["!a"], modified: [] })
  })
})

describe("the exact pass runs first, and a far exact counterpart outranks a near edit", () => {
  it("reads the near element as new when its would-be predecessor moved away intact", () => {
    expect(
      ruleDelta(
        [rule({ type: "guard", line: 10, condition: "!x" })],
        [
          rule({ type: "guard", line: 11, condition: "!y" }),
          rule({ type: "guard", line: 60, condition: "!x" }),
        ],
      ),
    ).toEqual({ added: ["!y"], removed: [], modified: [] })
  })

  it("reports the displaced element as removed rather than edited", () => {
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 10, condition: "!a" }),
          rule({ type: "guard", line: 20, condition: "!b" }),
        ],
        [
          rule({ type: "guard", line: 10, condition: "!b" }),
          rule({ type: "guard", line: 20, condition: "!c" }),
        ],
      ),
    ).toEqual({ added: ["!c"], removed: ["!a"], modified: [] })
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

  it("decorators: an unchanged receiver is claimed before a nearer edited one", () => {
    const post = (qualifier: string, line: number) =>
      decorator({ name: "Post", qualifier, line, arguments: ["/x"] })
    const delta = computeSymbolDelta(
      symbolWith({ decorators: [post("nest", 1)] }, "a"),
      symbolWith({ decorators: [post("tsed", 1), post("nest", 3)] }, "b"),
      { lineFuzz: 2 },
    )
    expect(delta.decorators).toEqual({ added: [post("tsed", 1)], removed: [], modified: [] })
  })

  it("decorators: a receiver edit that also moved beyond lineFuzz is added + removed", () => {
    // The near pass does not reach it, as it does not reach a changed argument list that far.
    const delta = computeSymbolDelta(
      symbolWith({ decorators: [decorator({ name: "Post", qualifier: "nest", line: 1 })] }, "a"),
      symbolWith({ decorators: [decorator({ name: "Post", qualifier: "tsed", line: 10 })] }, "b"),
      { lineFuzz: 2 },
    )
    expect(delta.decorators).toEqual({
      added: [decorator({ name: "Post", qualifier: "tsed", line: 10 })],
      removed: [decorator({ name: "Post", qualifier: "nest", line: 1 })],
      modified: [],
    })
  })
})

describe("pairings are chosen as a set, not one element at a time", () => {
  it("pairs two edits at the edge of the window", () => {
    expect(
      ruleDelta(
        [
          rule({ type: "guard", line: 1, condition: "!a" }),
          rule({ type: "guard", line: 2, condition: "!b" }),
        ],
        [
          rule({ type: "guard", line: 2, condition: "!aEdited" }),
          rule({ type: "guard", line: 3, condition: "!bEdited" }),
        ],
        1,
      ),
    ).toEqual({ added: [], removed: [], modified: ["!aEdited", "!bEdited"] })
  })

  it("reports two edits as two edits when both neighbours moved", () => {
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

  it("keeps a block of identical rules quiet however far it moved", () => {
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
    ).toEqual({ added: [], removed: [], modified: [] })
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
    expect(
      effectDelta(
        [at("effects-prisma", 1), at("effects-drizzle", 2)],
        [at("effects-drizzle", 1), at("effects-prisma", 2)],
      ),
    ).toEqual({ added: [], removed: [], modified: [] })
  })

  it("reports nothing for effects of different keys that changed places", () => {
    const write = (target: string, line: number) =>
      effect({ id: "db.write", target, plugin: "effects-prisma", line })
    const delta = computeSymbolDelta(
      makeSymbol({
        id: "ts:src/a.ts#f",
        name: "f",
        effects: [write("a.create", 1), write("b.create", 2), write("c.create", 3)],
        fingerprint: fp("a"),
      }),
      makeSymbol({
        id: "ts:src/a.ts#f",
        name: "f",
        effects: [write("c.create", 1), write("b.create", 2), write("a.create", 3)],
        fingerprint: fp("b"),
      }),
    )
    expect(delta.effects).toEqual({ added: [], removed: [], modified: [] })
  })

  it("gives a propagated entry the nearest local one when it must choose", () => {
    expect(effectDelta([at("far", 100), at("near", 1)], [at("propagated")])).toEqual({
      added: [],
      removed: ["far"],
      modified: ["propagated"],
    })
  })
})

describe("array order decides only where it has to", () => {
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
    const reversedBase = [...equidistant].reverse()
    expect(ruleDelta(reversedBase, edited)).toEqual(ruleDelta(reversedBase, edited))
    expect(ruleDelta(reversedBase, edited)).toEqual({
      added: [],
      removed: ["!first"],
      modified: ["!edited"],
    })
  })

  it("pairs an edit with the nearest candidate, not the first one written", () => {
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
