import { checkIRIntegrity } from "@aburi/core"
import type { Component, Dependency, IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, DiffError } from "../src"
import { component, dependency, fp, makeIR, makeSymbol } from "./fixtures"

/**
 * `buildDiff` keys three collections by identity, all three of them Document invariants
 * (ir-schema.md §14 #1, #2, #13). diff-algorithm.md §3.7 is the canonical statement of what
 * the diff does with a repeat and why it is checked at the entry point as well as at
 * extraction time.
 *
 * What each case here fixes in place is the *outcome* §3.7 forbids: every one produced an
 * answer rather than a crash, and an answer with an entry silently missing is one no reader
 * of the diff can tell from the truth.
 */

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

function diff(baseIR: IR, headIR: IR) {
  return buildDiff({ baseIR, headIR, base: IR_REF, head: IR_REF })
}

/** The `DiffError` a call threw, or `null` when it returned. */
function thrownBy(run: () => unknown): DiffError | null {
  try {
    run()
    return null
  } catch (error) {
    if (error instanceof DiffError) return error
    throw error
  }
}

const foo = () => makeSymbol({ id: "ts:src/a.ts#foo", name: "foo" })

describe("Symbol id collisions (ir-schema.md §14 #1)", () => {
  it("refuses a repeat on the head side instead of dropping one of the pair", () => {
    // §3.7: stage 1's lookup map is last-write-wins, so the base Symbol pairs with the
    // *second* entry and the first appears in neither `matched` nor `added` — `usedHead`
    // then removes both. Two head Symbols in, `changed: 1, added: 0` out.
    const head = makeIR({
      symbols: [
        makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("b") }),
        makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("c") }),
      ],
    })
    const error = thrownBy(() => diff(makeIR({ symbols: [foo()] }), head))
    expect(error?.code).toBe("ir-identity-collision")
    expect(error?.value).toBe("ts:src/a.ts#foo")
    expect(error?.message).toContain("headIR.symbols[1]")
    expect(error?.message).toContain("index 0")
  })

  it("refuses a repeat on the base side instead of counting the head Symbol twice", () => {
    // Both base entries find the same head Symbol, which is then classified twice —
    // `changed: 1` and `unchanged: 1` for one Symbol.
    const base = makeIR({
      symbols: [foo(), makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("z") })],
    })
    const error = thrownBy(() => diff(base, makeIR({ symbols: [foo()] })))
    expect(error?.code).toBe("ir-identity-collision")
    expect(error?.message).toContain("baseIR.symbols[1]")
  })

  it("refuses a repeat that has no counterpart on the other side", () => {
    // Nothing is lost here — both are reported as `added` — but the diff's own `symbols[]`
    // then carries two entries under one id, which `aburi.diff.v1` readers key on too.
    const head = makeIR({
      symbols: [foo(), makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("q") })],
    })
    expect(thrownBy(() => diff(makeIR(), head))?.code).toBe("ir-identity-collision")
  })

  it("refuses a repeat that stage 1 leaves for a later stage", () => {
    // Only stage 1 pairs by id; stages 2 to 4.5 pair by rename map, logic fingerprint,
    // name+signature and weak match — but each tracks the base Symbols it has consumed in a
    // `Set<SymbolId>`, so a repeat is dropped there just as quietly. Here the loss is a base
    // Symbol reported neither moved nor removed, with the run answering `moved: 1`.
    const base = makeIR({
      symbols: [
        makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("s") }),
        makeSymbol({ id: "ts:src/a.ts#foo", name: "bar", fingerprint: fp("t") }),
      ],
    })
    const head = makeIR({
      symbols: [makeSymbol({ id: "ts:src/b.ts#foo", name: "foo", fingerprint: fp("s") })],
    })
    expect(thrownBy(() => diff(base, head))?.code).toBe("ir-identity-collision")
  })
})

describe("Component id collisions (ir-schema.md §14 #2)", () => {
  const collidingComponents = () => [
    component({ id: "a", name: "A", roots: ["apps/a"] }),
    component({ id: "a", name: "A", roots: ["apps/a2"] }),
  ]
  const soleComponent = () => [component({ id: "a", name: "A", roots: ["apps/a"] })]

  it("refuses a repeat instead of reporting a change between two entries of one side", () => {
    // `diffComponents` builds its lookup with `Map.set`, so the second entry replaces the
    // first and the surviving pair compares `apps/a2` against `apps/a` — `componentsChanged:
    // 1` for two revisions that agree on every component the head declares.
    const error = thrownBy(() =>
      diff(makeIR({ components: collidingComponents() }), makeIR({ components: soleComponent() })),
    )
    expect(error?.code).toBe("ir-identity-collision")
    expect(error?.value).toBe("a")
    expect(error?.message).toContain("baseIR.components[1]")
  })

  it("checks the head side too", () => {
    const error = thrownBy(() =>
      diff(makeIR({ components: soleComponent() }), makeIR({ components: collidingComponents() })),
    )
    expect(error?.message).toContain("headIR.components[1]")
  })
})

describe("Dependency triple collisions (ir-schema.md §14 #13)", () => {
  const differingDirection = () => [
    dependency({ from: "a", to: "b", via: "import", direction: "outbound" }),
    dependency({ from: "a", to: "b", via: "import", direction: "inbound" }),
  ]

  it("refuses a repeat instead of surfacing it as an added + removed pair", () => {
    // `depsAdded: 1, depsRemoved: 1` — which is exactly how §6.2 encodes a genuine direction
    // flip between the two revisions. Invariant #13 names this outcome as its own reason.
    // Differing only in `direction`, so this is also the case that pins `direction` out of
    // the key: fold it in and the collision disappears.
    const head = makeIR({
      dependencies: [dependency({ from: "a", to: "b", via: "import", direction: "outbound" })],
    })
    const error = thrownBy(() => diff(makeIR({ dependencies: differingDirection() }), head))
    expect(error?.code).toBe("ir-identity-collision")
    expect(error?.value).toBe("(a, b, import)")
    expect(error?.message).toContain("baseIR.dependencies[1]")
  })

  it("checks the head side too", () => {
    const error = thrownBy(() => diff(makeIR(), makeIR({ dependencies: differingDirection() })))
    expect(error?.message).toContain("headIR.dependencies[1]")
  })

  it("identifies by the triple alone, as §6.2 does", () => {
    // `effect` is excluded from identity on the same terms as `direction`, and is the half
    // no other case here covers: every other fixture leaves `effect` null on both entries,
    // so folding it into the key would slip past all of them.
    const differingEffect = makeIR({
      dependencies: [
        dependency({ from: "a", to: "b", via: "import", effect: "db.read" }),
        dependency({ from: "a", to: "b", via: "import", effect: "db.write" }),
      ],
    })
    expect(thrownBy(() => diff(differingEffect, makeIR()))?.code).toBe("ir-identity-collision")
  })

  it("keeps the boundaries between the three fields", () => {
    // The triple is joined into one key, so the join has to be injective: these two edges
    // concatenate to the same characters and are not the same edge. Getting this wrong would
    // not only invent a collision here — `diffDependencies` keys the same way and would
    // merge them. (Core's #13 joins on a different separator, so the two implementations
    // agree for every endpoint satisfying the §3.1 / §4 grammars and are not guaranteed to
    // for one that does not; `buildDiff` checks no grammar.)
    const adjacent = makeIR({
      dependencies: [
        dependency({ from: "ab", to: "c", via: "import" }),
        dependency({ from: "a", to: "bc", via: "import" }),
      ],
    })
    expect(thrownBy(() => diff(adjacent, adjacent))).toBeNull()
    expect(diff(makeIR(), adjacent).summary.depsAdded).toBe(2)
  })

  it("treats a differing `via` as a different edge", () => {
    const twoEdges = makeIR({
      dependencies: [
        dependency({ from: "a", to: "b", via: "import" }),
        dependency({ from: "a", to: "b", via: "call" }),
      ],
    })
    expect(thrownBy(() => diff(twoEdges, twoEdges))).toBeNull()
  })
})

describe("the identity fields are established before they are read", () => {
  // The scan reads `.id` / `.from` off every entry, so it is the first code to dereference
  // them — and reading them is what forces the check. Without it, `symbols: [null]` reached
  // `matchStageId` and failed on `null.id` with no collection or index named, while a single
  // Symbol carrying *no* `id` had nothing to collide with, passed, and derived a Slice
  // anchored on `undefined` — reported as `slice-invariant-violated`, the one code the CLI
  // presents as a bug in Aburi rather than in the caller's IR.
  const withoutId = () => {
    const bad = { ...foo() } as Record<string, unknown>
    delete bad.id
    return bad as unknown as IRSymbol
  }

  const cases: ReadonlyArray<[string, Partial<IR>, string]> = [
    ["a null Symbol", { symbols: [null as unknown as IRSymbol] }, "baseIR.symbols[0]"],
    ["a null Component", { components: [null as unknown as Component] }, "baseIR.components[0]"],
    [
      "a numeric Dependency",
      { dependencies: [7 as unknown as Dependency] },
      "baseIR.dependencies[0]",
    ],
    ["a Symbol with no id", { symbols: [withoutId()] }, "baseIR.symbols[0].id"],
    [
      "a Symbol whose id is a number",
      { symbols: [{ ...foo(), id: 42 } as unknown as IRSymbol] },
      "baseIR.symbols[0].id",
    ],
    [
      "a Dependency with no via",
      { dependencies: [{ from: "a", to: "b" } as unknown as Dependency] },
      "baseIR.dependencies[0].via",
    ],
  ]

  for (const [label, overrides, subject] of cases) {
    it(`names ${subject} for ${label}`, () => {
      const broken = { ...makeIR(), ...overrides } as IR
      const error = thrownBy(() => diff(broken, makeIR()))
      expect(error?.code).toBe("ir-shape-invalid")
      expect(error?.message).toContain(subject)
    })
  }

  it("distinguishes an absent field from a null one", () => {
    const absent = { ...makeIR(), symbols: [withoutId()] } as IR
    const nulled = { ...makeIR(), symbols: [{ ...foo(), id: null } as unknown as IRSymbol] } as IR
    expect(thrownBy(() => diff(absent, makeIR()))?.message).toContain("got undefined")
    expect(thrownBy(() => diff(nulled, makeIR()))?.message).toContain("got null")
  })
})

describe("the diff-side rule is the Document's rule", () => {
  // The check restates ir-schema.md §14 #1 / #2 / #13 at the diff boundary rather than
  // running `checkIRIntegrity`, which would make `buildDiff` enforce further rules that do
  // not change its answer. A restatement is a second source of truth: if core ever stops
  // requiring one of these, this fails instead of the two quietly disagreeing. It does not
  // pin the two *definitions* together — core comparing #1 after NFC normalisation would
  // still pass here.
  const cases: ReadonlyArray<[number, IR]> = [
    [1, makeIR({ symbols: [foo(), foo()] })],
    [
      2,
      makeIR({
        components: [component({ id: "a", name: "A" }), component({ id: "a", name: "A" })],
      }),
    ],
    [
      13,
      makeIR({
        dependencies: [
          dependency({ from: "a", to: "b", via: "import" }),
          dependency({ from: "a", to: "b", via: "import" }),
        ],
      }),
    ],
  ]

  for (const [invariant, ir] of cases) {
    it(`invariant #${invariant} is what rejects the fixture buildDiff rejects`, () => {
      expect(checkIRIntegrity(ir).map((v) => v.invariant)).toContain(invariant)
      expect(thrownBy(() => diff(ir, makeIR()))?.code).toBe("ir-identity-collision")
    })
  }
})

describe("a Document with unique identities is unaffected", () => {
  const clean = (seed: string) =>
    makeIR({
      symbols: [makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", component: "a", ...fpOf(seed) })],
      components: [component({ id: "a", name: "A" })],
    })
  const fpOf = (seed: string) => ({ fingerprint: fp(seed) })

  it("reports the same diff it always did", () => {
    expect(diff(clean("a"), clean("b")).summary.changed).toBe(1)
  })

  it("is a Document the integrity checker also accepts", () => {
    // The other half of the drift guard: the rejected fixtures above pin that both sides say
    // no, and this pins that the accepted one is a Document core says yes to — without it,
    // a check that rejected everything would satisfy every case in this file.
    expect(checkIRIntegrity(clean("a"))).toEqual([])
  })

  it("reads every entry, not just the first two", () => {
    // A scan that stopped early would pass every collision case above, all of which collide
    // at index 1.
    const many = makeIR({
      symbols: [
        makeSymbol({ id: "ts:src/a.ts#a", name: "a" }),
        makeSymbol({ id: "ts:src/a.ts#b", name: "b" }),
        makeSymbol({ id: "ts:src/a.ts#c", name: "c" }),
        makeSymbol({ id: "ts:src/a.ts#a", name: "a2" }),
      ],
    })
    expect(thrownBy(() => diff(many, makeIR()))?.message).toContain("baseIR.symbols[3]")
  })
})

describe("which collision is reported is fixed", () => {
  it("reports the base side before the head side", () => {
    const collides = makeIR({ symbols: [foo(), foo()] })
    expect(thrownBy(() => diff(collides, collides))?.message).toContain("baseIR")
  })

  it("reports symbols before components before dependencies", () => {
    const collidingComponents = [
      component({ id: "a", name: "A" }),
      component({ id: "a", name: "A" }),
    ]
    const collidingDependencies = [
      dependency({ from: "a", to: "b", via: "import" }),
      dependency({ from: "a", to: "b", via: "import" }),
    ]
    const everything = makeIR({
      symbols: [foo(), foo()],
      components: collidingComponents,
      dependencies: collidingDependencies,
    })
    expect(thrownBy(() => diff(everything, makeIR()))?.message).toContain("baseIR.symbols[1]")

    const noSymbols = makeIR({
      components: collidingComponents,
      dependencies: collidingDependencies,
    })
    expect(thrownBy(() => diff(noSymbols, makeIR()))?.message).toContain("baseIR.components[1]")
  })
})
