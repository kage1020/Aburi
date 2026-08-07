import { checkIRIntegrity } from "@aburi/core"
import type { Component, Dependency, IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, DiffError } from "../src"
import { component, dependency, fp, makeIR, makeSymbol } from "./fixtures"

/**
 * `buildDiff` keys three collections by identity: the 5-stage matcher on `symbols[].id`,
 * `diffComponents` on `components[].id`, `diffDependencies` on the `(from, to, via)` triple.
 * All three are Document invariants (ir-schema.md §14 #1, #2, #13), and until this file
 * nothing checked them at the diff boundary — `buildDiff` is public API and runs no
 * integrity check, so a caller that builds an IR itself reached the matcher unverified.
 *
 * What made it worth a coded error rather than a note in the docs: every case below
 * produced an *answer*, not a crash. A dropped Symbol is indistinguishable from one that
 * was never there, and a spurious dependency flip is indistinguishable from a real one.
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
    // Before: stage 1 pairs the base Symbol with the first head entry and then removes
    // *both* head entries via `usedHead`, so the second appeared in neither `matched` nor
    // `added` — the run reported `changed: 1, added: 0` for two head Symbols.
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
    // Before: both base entries found the same head Symbol, which was classified twice —
    // `changed: 1` and `unchanged: 1` for a single head Symbol.
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
    // The loss is not confined to `matchStageId`: stages 3, 4 and 4.5 all track consumed
    // base Symbols in a `Set<SymbolId>`, so a repeat there was dropped just as quietly.
    // Before: `moved: 1`, with the second base Symbol reported neither moved nor removed.
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
  it("refuses a repeat instead of reporting a change between two entries of one side", () => {
    // Before: `diffComponents` builds `Map<ComponentId, Component>` with `set`, so the
    // second entry replaced the first and the surviving pair compared `apps/a2` against
    // `apps/a` — `componentsChanged: 1` for two revisions that agree on every component
    // the head actually declares.
    const base = makeIR({
      components: [
        component({ id: "a", name: "A", roots: ["apps/a"] }),
        component({ id: "a", name: "A", roots: ["apps/a2"] }),
      ],
    })
    const head = makeIR({ components: [component({ id: "a", name: "A", roots: ["apps/a"] })] })
    const error = thrownBy(() => diff(base, head))
    expect(error?.code).toBe("ir-identity-collision")
    expect(error?.value).toBe("a")
    expect(error?.message).toContain("baseIR.components[1]")
  })
})

describe("Dependency triple collisions (ir-schema.md §14 #13)", () => {
  it("refuses a repeat instead of surfacing it as an added + removed pair", () => {
    // Before: `depsAdded: 1, depsRemoved: 1` — indistinguishable from a genuine direction
    // flip between the two revisions. Invariant #13 names this outcome as its own reason.
    const base = makeIR({
      dependencies: [
        dependency({ from: "a", to: "b", via: "import", direction: "outbound" }),
        dependency({ from: "a", to: "b", via: "import", direction: "inbound" }),
      ],
    })
    const head = makeIR({
      dependencies: [dependency({ from: "a", to: "b", via: "import", direction: "outbound" })],
    })
    const error = thrownBy(() => diff(base, head))
    expect(error?.code).toBe("ir-identity-collision")
    expect(error?.value).toBe("a::b::import")
    expect(error?.message).toContain("baseIR.dependencies[1]")
  })

  it("identifies by the triple alone, as §6.2 does", () => {
    // `direction` and `effect` are excluded from identity by design, so entries differing
    // only there collide. Stating it as its own case pins the exclusion: an implementation
    // that folded `direction` into the key would pass every other test in this file.
    const withEffects = makeIR({
      dependencies: [
        dependency({ from: "a", to: "b", via: "import", effect: "db.read" }),
        dependency({ from: "a", to: "b", via: "import", effect: "db.write" }),
      ],
    })
    expect(thrownBy(() => diff(withEffects, makeIR()))?.code).toBe("ir-identity-collision")
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

describe("the collections the identity scan walks are objects", () => {
  // The scan reads `.id` / `.from` off every entry, so it is the first code to dereference
  // them. `assertIRShape` established that the collections are arrays and stopped there,
  // which left `symbols: [null]` to reach the matcher and fail as a `TypeError` with no
  // collection or index named.
  const cases: ReadonlyArray<[string, Partial<IR>]> = [
    ["symbols", { symbols: [null as unknown as IRSymbol] }],
    ["components", { components: [null as unknown as Component] }],
    ["dependencies", { dependencies: [7 as unknown as Dependency] }],
  ]

  for (const [field, overrides] of cases) {
    it(`names \`${field}[0]\` rather than throwing a TypeError`, () => {
      const broken = { ...makeIR(), ...overrides } as IR
      const error = thrownBy(() => diff(broken, makeIR()))
      expect(error?.code).toBe("ir-shape-invalid")
      expect(error?.message).toContain(`baseIR.${field}[0]`)
    })
  }
})

describe("the diff-side rule is the Document's rule", () => {
  // The check restates ir-schema.md §14 #1 / #2 / #13 at the diff boundary rather than
  // running `checkIRIntegrity`, which would make `buildDiff` enforce sixteen further rules
  // that do not change its answer. A restatement is a second source of truth, so each
  // fixture is asserted against the original: if core ever stops requiring one of these,
  // this fails instead of the two quietly disagreeing.
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
  it("reports the same diff it always did", () => {
    const base = makeIR({
      symbols: [foo()],
      components: [component({ id: "a", name: "A" })],
      dependencies: [dependency({ from: "a", to: "b", via: "import" })],
    })
    const head = makeIR({
      symbols: [makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("b") })],
      components: [component({ id: "a", name: "A" })],
      dependencies: [dependency({ from: "a", to: "b", via: "import" })],
    })
    expect(diff(base, head).summary.changed).toBe(1)
  })

  it("reads every entry, not just the first two", () => {
    // A scan that stopped early would pass every case above, all of which collide at
    // index 1.
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
    const everything = makeIR({
      symbols: [foo(), foo()],
      components: [component({ id: "a", name: "A" }), component({ id: "a", name: "A" })],
      dependencies: [
        dependency({ from: "a", to: "b", via: "import" }),
        dependency({ from: "a", to: "b", via: "import" }),
      ],
    })
    expect(thrownBy(() => diff(everything, makeIR()))?.message).toContain("baseIR.symbols[1]")

    const noSymbols = makeIR({
      components: [component({ id: "a", name: "A" }), component({ id: "a", name: "A" })],
      dependencies: [
        dependency({ from: "a", to: "b", via: "import" }),
        dependency({ from: "a", to: "b", via: "import" }),
      ],
    })
    expect(thrownBy(() => diff(noSymbols, makeIR()))?.message).toContain("baseIR.components[1]")
  })
})
