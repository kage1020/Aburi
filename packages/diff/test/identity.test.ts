import { checkIRIntegrity } from "@aburi/core"
import { component, dependency, fp, makeIR, makeSymbol } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffOf, refusalOf } from "./helpers"

const foo = (seed = "a") =>
  makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", fingerprint: fp(seed) })
const componentA = (root: string) => component({ id: "a", name: "A", roots: [root] })
const edgeAB = (overrides: Partial<Parameters<typeof dependency>[0]> = {}) =>
  dependency({ from: "a", to: "b", via: "import", ...overrides })

const collidingSymbols = () => makeIR({ symbols: [foo("a"), foo("b")] })
const collidingComponents = () =>
  makeIR({ components: [componentA("apps/a"), componentA("apps/a2")] })
const collidingDependencies = () =>
  makeIR({
    dependencies: [edgeAB({ direction: "outbound" }), edgeAB({ direction: "inbound" })],
  })

describe("a repeated identity", () => {
  it.each<[string, "baseIR" | "headIR", () => IR, string, string]>([
    ["a Symbol id", "baseIR", collidingSymbols, "symbols[1]", "ts:src/a.ts#foo"],
    ["a Symbol id", "headIR", collidingSymbols, "symbols[1]", "ts:src/a.ts#foo"],
    ["a Component id", "baseIR", collidingComponents, "components[1]", "a"],
    ["a Component id", "headIR", collidingComponents, "components[1]", "a"],
    ["a Dependency triple", "baseIR", collidingDependencies, "dependencies[1]", "(a, b, import)"],
    ["a Dependency triple", "headIR", collidingDependencies, "dependencies[1]", "(a, b, import)"],
  ])("is refused for %s on %s, naming both indexes", async (_, side, colliding, entry, value) => {
    const [base, head] = side === "baseIR" ? [colliding(), makeIR()] : [makeIR(), colliding()]
    const error = await refusalOf(base, head)
    expect(error.code).toBe("ir-identity-collision")
    expect(error.value).toBe(value)
    expect(error.message).toContain(`${side}.${entry}`)
    expect(error.message).toContain("first seen at index 0")
  })

  it("identifies a Dependency by its (from, to, via) triple alone, not its effect", async () => {
    const differingEffect = makeIR({
      dependencies: [edgeAB({ effect: "db.read" }), edgeAB({ effect: "db.write" })],
    })
    const error = await refusalOf(differingEffect, makeIR())
    expect(error.code).toBe("ir-identity-collision")
  })

  it("is found at any index, not only among the first entries", async () => {
    const many = makeIR({
      symbols: ["a", "b", "c"]
        .map((name) => makeSymbol({ id: `ts:src/a.ts#${name}`, name }))
        .concat(makeSymbol({ id: "ts:src/a.ts#a", name: "a2" })),
    })
    const error = await refusalOf(many, makeIR())
    expect(error.message).toContain("baseIR.symbols[3]")
  })
})

describe("Dependencies that merely look alike", () => {
  it.each([
    [
      "the boundary between from and to differs",
      [
        dependency({ from: "ab", to: "c", via: "import" }),
        dependency({ from: "a", to: "bc", via: "import" }),
      ],
    ],
    ["the via differs", [edgeAB({ via: "import" }), edgeAB({ via: "call" })]],
  ])("are two edges when %s", (_, dependencies) => {
    const ir = makeIR({ dependencies })
    expect(() => diffOf(ir, ir)).not.toThrow()
    expect(diffOf(makeIR(), ir).summary.depsAdded).toBe(2)
  })
})

describe("which collision is reported", () => {
  it("is the base side's before the head side's", async () => {
    const error = await refusalOf(collidingSymbols(), collidingSymbols())
    expect(error.message).toContain("baseIR")
  })

  it("is the symbols' before the components' before the dependencies'", async () => {
    const { components } = collidingComponents()
    const { dependencies } = collidingDependencies()
    const everything = makeIR({ symbols: collidingSymbols().symbols, components, dependencies })
    expect((await refusalOf(everything, makeIR())).message).toContain("baseIR.symbols[1]")
    const noSymbols = makeIR({ components, dependencies })
    expect((await refusalOf(noSymbols, makeIR())).message).toContain("baseIR.components[1]")
  })
})

describe("the integrity checker", () => {
  it.each([
    ["a repeated Symbol id", collidingSymbols, "duplicate Symbol id"],
    ["a repeated Component id", collidingComponents, "duplicate Component id"],
    [
      "a repeated Dependency triple",
      collidingDependencies,
      "duplicate (from, to, via) triple in dependencies[]",
    ],
  ])("rejects %s too, and for nothing else", (_, colliding, message) => {
    expect(checkIRIntegrity(colliding()).map((violation) => violation.message)).toEqual([message])
  })

  it("accepts a Document with unique identities, as the diff does", () => {
    const clean = makeIR({
      symbols: [makeSymbol({ id: "ts:src/a.ts#foo", name: "foo", component: "a" })],
      components: [component({ id: "a", name: "A" })],
    })
    expect(checkIRIntegrity(clean)).toEqual([])
    expect(() => diffOf(clean, clean)).not.toThrow()
  })
})
