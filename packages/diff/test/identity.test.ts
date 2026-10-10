import { checkIRIntegrity } from "@aburi/core"
import { component, dependency, fp, makeIR, makeSymbol } from "@aburi/test-support"
import type { Component, Dependency, IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, DiffError } from "../src"

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

describe("Symbol id collisions (ir-schema.md #1)", () => {
  it("refuses a repeat on the head side instead of dropping one of the pair", () => {
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
    const base = makeIR({
      symbols: [foo(), makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("z") })],
    })
    const error = thrownBy(() => diff(base, makeIR({ symbols: [foo()] })))
    expect(error?.code).toBe("ir-identity-collision")
    expect(error?.message).toContain("baseIR.symbols[1]")
  })

  it("refuses a repeat that has no counterpart on the other side", () => {
    const head = makeIR({
      symbols: [foo(), makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp("q") })],
    })
    expect(thrownBy(() => diff(makeIR(), head))?.code).toBe("ir-identity-collision")
  })

  it("refuses a repeat that stage 1 leaves for a later stage", () => {
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

describe("Component id collisions (ir-schema.md #2)", () => {
  const collidingComponents = () => [
    component({ id: "a", name: "A", roots: ["apps/a"] }),
    component({ id: "a", name: "A", roots: ["apps/a2"] }),
  ]
  const soleComponent = () => [component({ id: "a", name: "A", roots: ["apps/a"] })]

  it("refuses a repeat instead of reporting a change between two entries of one side", () => {
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

describe("Dependency triple collisions (ir-schema.md #13)", () => {
  const differingDirection = () => [
    dependency({ from: "a", to: "b", via: "import", direction: "outbound" }),
    dependency({ from: "a", to: "b", via: "import", direction: "inbound" }),
  ]

  it("refuses a repeat instead of surfacing it as an added + removed pair", () => {
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

  it("identifies by the triple alone, as diff-algorithm.md does", () => {
    const differingEffect = makeIR({
      dependencies: [
        dependency({ from: "a", to: "b", via: "import", effect: "db.read" }),
        dependency({ from: "a", to: "b", via: "import", effect: "db.write" }),
      ],
    })
    expect(thrownBy(() => diff(differingEffect, makeIR()))?.code).toBe("ir-identity-collision")
  })

  it("keeps the boundaries between the three fields", () => {
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
  const withoutId = () => {
    const bad = { ...foo() } as Record<string, unknown>
    delete bad.id
    return bad as unknown as IRSymbol
  }

  const cases: ReadonlyArray<[string, Partial<IR>, string, string]> = [
    ["a null Symbol", { symbols: [null as unknown as IRSymbol] }, "baseIR.symbols[0]", "null"],
    [
      "a null Component",
      { components: [null as unknown as Component] },
      "baseIR.components[0]",
      "null",
    ],
    [
      "a numeric Dependency",
      { dependencies: [7 as unknown as Dependency] },
      "baseIR.dependencies[0]",
      "a number",
    ],
    ["a Symbol with no id", { symbols: [withoutId()] }, "baseIR.symbols[0]", '"id" is absent'],
    [
      "a Symbol whose id is a number",
      { symbols: [{ ...foo(), id: 42 } as unknown as IRSymbol] },
      "baseIR.symbols[0]",
      '"id" is a number',
    ],
    [
      "a Dependency with no via",
      { dependencies: [{ from: "a", to: "b" } as unknown as Dependency] },
      "baseIR.dependencies[0]",
      '"via" is absent',
    ],
  ]

  for (const [label, overrides, subject, detail] of cases) {
    it(`names ${subject} for ${label}`, () => {
      const broken = { ...makeIR(), ...overrides } as IR
      const error = thrownBy(() => diff(broken, makeIR()))
      expect(error?.code).toBe("ir-shape-invalid")
      expect(error?.message).toContain(subject)
      expect(error?.message).toContain(detail)
    })
  }

  it("distinguishes an absent field from a null one", () => {
    const absent = { ...makeIR(), symbols: [withoutId()] } as IR
    const nulled = { ...makeIR(), symbols: [{ ...foo(), id: null } as unknown as IRSymbol] } as IR
    expect(thrownBy(() => diff(absent, makeIR()))?.message).toContain('"id" is absent')
    expect(thrownBy(() => diff(nulled, makeIR()))?.message).toContain('"id" is null')
  })
})

describe("the diff-side rule is the Document's rule", () => {
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
    expect(checkIRIntegrity(clean("a"))).toEqual([])
  })

  it("reads every entry, not just the first two", () => {
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
