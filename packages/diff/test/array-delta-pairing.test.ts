import { call, decorator, effect, fp, makeSymbol, rule } from "@aburi/test-support"
import type { Effect, Symbol as IRSymbol, Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { computeSymbolDelta } from "../src"

const NOTHING = { added: [], removed: [], modified: [] }

const guard = (line: number, condition: string): Rule => rule({ type: "guard", line, condition })

const GUARD_PAIR = [guard(1, "!user"), guard(3, "!invoice")]

function deltaOf(base: Partial<IRSymbol>, head: Partial<IRSymbol>, lineFuzz?: number) {
  const symbol = (arrays: Partial<IRSymbol>, seed: string) =>
    makeSymbol({ id: "ts:src/a.ts#handle", name: "handle", fingerprint: fp(seed), ...arrays })
  return computeSymbolDelta(
    symbol(base, "a"),
    symbol(head, "b"),
    lineFuzz === undefined ? {} : { lineFuzz },
  )
}

/** Each bucket as the conditions in it, so a case reads as what the reviewer would see. */
function ruleDelta(base: Rule[], head: Rule[], lineFuzz?: number) {
  const rules = deltaOf({ rules: base }, { rules: head }, lineFuzz).rules
  const conditions = (items: readonly unknown[] | undefined) =>
    (items ?? []).map((item) => (item as Rule).condition)
  return {
    added: conditions(rules?.added),
    removed: conditions(rules?.removed),
    modified: conditions(rules?.modified),
  }
}

describe("an unchanged rule is paired with its own counterpart", () => {
  it.each([
    [
      "the second of two guards was deleted",
      GUARD_PAIR,
      [guard(3, "!invoice")],
      { ...NOTHING, removed: ["!user"] },
    ],
    [
      "the first of two guards survived",
      GUARD_PAIR,
      [guard(1, "!user")],
      { ...NOTHING, removed: ["!invoice"] },
    ],
    [
      "another rule of its key sits nearer",
      [guard(1, "!invoice"), guard(2, "!user")],
      [guard(3, "!invoice")],
      { ...NOTHING, removed: ["!user"] },
    ],
    [
      "a block of rules shifted down a line",
      [guard(1, "!a"), guard(2, "!b")],
      [guard(2, "!a"), guard(3, "!b")],
      NOTHING,
    ],
    [
      "two guards swapped places",
      [guard(1, "!a"), guard(2, "!b")],
      [guard(1, "!b"), guard(2, "!a")],
      NOTHING,
    ],
    [
      "a block of identical rules moved far",
      [guard(1, "!same"), guard(2, "!same")],
      [guard(40, "!same"), guard(41, "!same")],
      NOTHING,
    ],
    [
      "its counterpart moved far while an edit landed near",
      [guard(10, "!x")],
      [guard(11, "!y"), guard(60, "!x")],
      { ...NOTHING, added: ["!y"] },
    ],
    [
      "it moved into the place of a neighbour that was replaced",
      [guard(10, "!a"), guard(20, "!b")],
      [guard(10, "!b"), guard(20, "!c")],
      { ...NOTHING, added: ["!c"], removed: ["!a"] },
    ],
    [
      "two head rules could claim it",
      [guard(2, "!kept")],
      [guard(1, "!kept"), guard(3, "!added")],
      { ...NOTHING, added: ["!added"] },
    ],
    [
      "it moved past a sibling of its key, which is not a line shift",
      [guard(1, "!a"), guard(2, "!b")],
      [guard(1, "!b"), guard(31, "!a")],
      { ...NOTHING, added: ["!a"], removed: ["!a"] },
    ],
  ])("when %s", (_, base, head, expected) => {
    expect(ruleDelta(base, head)).toEqual(expected)
  })

  it.each([0, 2, 10])("however far it moved, at lineFuzz=%i", (lineFuzz) => {
    expect(ruleDelta([guard(1, "!user")], [guard(40, "!user")], lineFuzz)).toEqual(NOTHING)
  })
})

describe("an edited rule is paired with a free candidate within the window", () => {
  it.each([
    [
      "one of two guards changed",
      GUARD_PAIR,
      [guard(1, "!owner"), guard(3, "!invoice")],
      2,
      { ...NOTHING, modified: ["!owner"] },
    ],
    [
      "the body around it moved too",
      [guard(1, "!user"), guard(2, "!owner"), guard(3, "!invoice")],
      [guard(21, "!user"), guard(22, "!admin"), guard(23, "!invoice")],
      2,
      { ...NOTHING, added: ["!admin"], removed: ["!owner"] },
    ],
    [
      "the nearest candidate is not the first one written",
      [guard(1, "!far"), guard(3, "!near")],
      [guard(3, "!edited")],
      2,
      { ...NOTHING, removed: ["!far"], modified: ["!edited"] },
    ],
    [
      "two edits sit at the edge of the window",
      [guard(1, "!a"), guard(2, "!b")],
      [guard(2, "!aEdited"), guard(3, "!bEdited")],
      1,
      { ...NOTHING, modified: ["!aEdited", "!bEdited"] },
    ],
    [
      "both neighbours of two edits moved",
      [guard(1, "!first"), guard(2, "!second")],
      [guard(3, "!firstEdited"), guard(4, "!secondEdited")],
      2,
      { ...NOTHING, modified: ["!firstEdited", "!secondEdited"] },
    ],
    [
      "two candidates are equally near, settling on the lower index",
      [guard(1, "!first"), guard(3, "!second")],
      [guard(2, "!edited")],
      2,
      { ...NOTHING, removed: ["!second"], modified: ["!edited"] },
    ],
    [
      "two candidates are equally near, written the other way round",
      [guard(3, "!second"), guard(1, "!first")],
      [guard(2, "!edited")],
      2,
      { ...NOTHING, removed: ["!first"], modified: ["!edited"] },
    ],
  ])("when %s", (_, base, head, lineFuzz, expected) => {
    expect(ruleDelta(base, head, lineFuzz)).toEqual(expected)
  })

  it.each<[number, string, number | undefined]>([
    [2, "left unset", undefined],
    [0, "0", 0],
    [1, "1", 1],
    [10, "10", 10],
  ])("pairs an edit %i lines away and no further when lineFuzz is %s", (within, _, lineFuzz) => {
    const base = [guard(1, "!user")]
    expect(ruleDelta(base, [guard(1 + within, "!admin")], lineFuzz)).toEqual({
      ...NOTHING,
      modified: ["!admin"],
    })
    expect(ruleDelta(base, [guard(2 + within, "!admin")], lineFuzz)).toEqual({
      added: ["!admin"],
      removed: ["!user"],
      modified: [],
    })
  })

  it("answers the same whichever way either side is written", () => {
    const head = [guard(1, "!owner"), guard(3, "!invoice")]
    const expected = ruleDelta(GUARD_PAIR, head)
    expect(ruleDelta([...GUARD_PAIR].reverse(), head)).toEqual(expected)
    expect(ruleDelta(GUARD_PAIR, [...head].reverse())).toEqual(expected)
    const near = guard(1, "!near")
    const far = guard(3, "!far")
    const base = [guard(1, "!original")]
    expect(ruleDelta(base, [far, near])).toEqual(ruleDelta(base, [near, far]))
    expect(ruleDelta(base, [near, far])).toEqual({
      ...NOTHING,
      added: ["!far"],
      modified: ["!near"],
    })
  })
})

describe("calls and decorators are paired under the same rule", () => {
  it("keeps the calls of a function that moved 14 lines down its file quiet", () => {
    const calls = (at: number) => [
      call({ target: "dirname", line: at }),
      call({ target: "mkdir", line: at }),
      call({ target: "writeFile", line: at + 1 }),
    ]
    expect(deltaOf({ calls: calls(32) }, { calls: calls(46) }).calls).toEqual(NOTHING)
  })

  it("pairs a call that moved past a call to a different target", () => {
    expect(
      deltaOf(
        { calls: [call({ target: "scan", line: 10 }), call({ target: "mkdir", line: 14 })] },
        { calls: [call({ target: "mkdir", line: 12 }), call({ target: "scan", line: 30 })] },
      ).calls,
    ).toEqual(NOTHING)
  })

  it("holds a block of identical calls to one target together", () => {
    const logs = (lines: number[]) => lines.map((line) => call({ target: "logger.info", line }))
    expect(deltaOf({ calls: logs([1, 2]) }, { calls: logs([3, 4]) }, 2).calls).toEqual(NOTHING)
  })

  it("reports the deleted one of two calls to one target", () => {
    const debug = call({ target: "log", line: 1, resolved: "ts:src/a.ts#debug" })
    const info = call({ target: "log", line: 3, resolved: "ts:src/a.ts#info" })
    expect(deltaOf({ calls: [debug, info] }, { calls: [info] }, 2).calls).toEqual({
      ...NOTHING,
      removed: [debug],
    })
  })

  it("keeps a moved decorator quiet", () => {
    const at = (line: number) => [decorator({ name: "Get", line, arguments: ["/a"] })]
    expect(deltaOf({ decorators: at(3) }, { decorators: at(30) }).decorators).toEqual(NOTHING)
  })

  it("holds a block of identical decorators together", () => {
    const stacked = (lines: number[]) =>
      lines.map((line) => decorator({ name: "Roles", line, arguments: ["admin"] }))
    expect(
      deltaOf({ decorators: stacked([1, 2]) }, { decorators: stacked([3, 4]) }, 2).decorators,
    ).toEqual(NOTHING)
  })

  it("reports the deleted one of two decorators with one name", () => {
    const first = decorator({ name: "Get", line: 1, arguments: ["/a"] })
    const second = decorator({ name: "Get", line: 3, arguments: ["/b"] })
    expect(
      deltaOf({ decorators: [first, second] }, { decorators: [second] }, 2).decorators,
    ).toEqual({ ...NOTHING, removed: [first] })
  })

  it("claims an unchanged receiver before a nearer edited one", () => {
    const post = (qualifier: string, line: number) =>
      decorator({ name: "Post", qualifier, line, arguments: ["/x"] })
    expect(
      deltaOf(
        { decorators: [post("nest", 1)] },
        { decorators: [post("tsed", 1), post("nest", 3)] },
        2,
      ).decorators,
    ).toEqual({ ...NOTHING, added: [post("tsed", 1)] })
  })

  it("reports a receiver edit that also moved beyond the window as added + removed", () => {
    const before = decorator({ name: "Post", qualifier: "nest", line: 1 })
    const after = decorator({ name: "Post", qualifier: "tsed", line: 10 })
    expect(deltaOf({ decorators: [before] }, { decorators: [after] }, 2).decorators).toEqual({
      added: [after],
      removed: [before],
      modified: [],
    })
  })
})

describe("effects are paired under the same rule, with no line window", () => {
  const write = (plugin: string, line?: number) =>
    effect({
      id: "db.write",
      target: "prisma.user.create",
      plugin,
      ...(line === undefined ? {} : { line }),
    })

  const effectPlugins = (base: Effect[], head: Effect[]) => {
    const effects = deltaOf({ effects: base }, { effects: head }).effects
    const plugins = (items: readonly unknown[] | undefined) =>
      (items ?? []).map((item) => (item as Effect).plugin)
    return {
      added: plugins(effects?.added),
      removed: plugins(effects?.removed),
      modified: plugins(effects?.modified),
    }
  }

  it("pairs an unchanged effect with itself however far its line moved", () => {
    expect(effectPlugins([write("effects-prisma", 10)], [write("effects-prisma", 9000)])).toEqual(
      NOTHING,
    )
  })

  it("keeps two entries of one key apart by content rather than by line", () => {
    expect(
      effectPlugins(
        [write("effects-prisma", 1), write("effects-drizzle", 2)],
        [write("effects-drizzle", 1), write("effects-prisma", 2)],
      ),
    ).toEqual(NOTHING)
  })

  it("reports nothing for effects of different keys that changed places", () => {
    const at = (target: string, line: number) =>
      effect({ id: "db.write", target, plugin: "effects-prisma", line })
    expect(
      deltaOf(
        { effects: [at("a.create", 1), at("b.create", 2), at("c.create", 3)] },
        { effects: [at("c.create", 1), at("b.create", 2), at("a.create", 3)] },
      ).effects,
    ).toEqual(NOTHING)
  })

  it("gives a propagated entry the nearest local one when it must choose", () => {
    expect(effectPlugins([write("far", 100), write("near", 1)], [write("propagated")])).toEqual({
      added: [],
      removed: ["far"],
      modified: ["propagated"],
    })
  })
})
