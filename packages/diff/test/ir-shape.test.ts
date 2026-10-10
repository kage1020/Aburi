import { component, fp, makeIR, makeSymbol } from "@aburi/test-support"
import type { Component, IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffOf, refusalOf } from "./helpers"

/** A pair whose Symbol changed, so the delta path runs over the fields it reads. */
function changedPair(): { base: IR; head: IR } {
  return {
    base: makeIR({ symbols: [makeSymbol({ id: "ts:src/a.ts#f", name: "f" })] }),
    head: makeIR({
      symbols: [makeSymbol({ id: "ts:src/a.ts#f", name: "f", fingerprint: fp("bbb") })],
    }),
  }
}

function without<T extends object>(record: T, ...fields: string[]): T {
  const copy = { ...record } as Record<string, unknown>
  for (const field of fields) delete copy[field]
  return copy as T
}

function headWithoutSymbolField(field: string): IR {
  const { head } = changedPair()
  return { ...head, symbols: head.symbols.map((symbol) => without(symbol, field)) }
}

describe("a Document that is not one", () => {
  const valid = makeIR()

  it.each<[string, () => [unknown, unknown], string]>([
    ["a null Document", () => [null, valid], "baseIR: Document is null, not an object."],
    [
      "an absent symbols[]",
      () => [{ ...valid, symbols: undefined }, valid],
      'baseIR: "symbols" is absent, not an array.',
    ],
    [
      "an absent components[]",
      () => [valid, { ...valid, components: undefined }],
      'headIR: "components" is absent, not an array.',
    ],
    [
      "a null dependencies[]",
      () => [valid, { ...valid, dependencies: null }],
      'headIR: "dependencies" is null, not an array.',
    ],
    [
      "an empty $schema",
      () => [{ ...valid, $schema: "" }, valid],
      'baseIR: "$schema" is empty, not a schema URL.',
    ],
  ])("is refused as ir-shape-invalid for %s", async (_, sides, message) => {
    const [base, head] = sides()
    const error = await refusalOf(base as IR, head as IR)
    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toBe(message)
  })

  it.each([
    "stats",
    "generator",
    "workspace",
  ])("is refused when it lacks %s, with no index to name", async (field) => {
    const { base, head } = changedPair()
    expect((await refusalOf(base, without(head, field))).message).toBe(
      `headIR: "${field}" is absent, not an object.`,
    )
  })

  it("is refused when it carries only the three collections", async () => {
    const minimal = {
      $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
      symbols: [],
      components: [],
      dependencies: [],
    } as unknown as IR
    const error = await refusalOf(minimal, minimal)
    expect(error.message).toContain("baseIR:")
    expect(error.violations?.map((v) => v.message).join(" ")).toMatch(
      /"generator".*"workspace".*"stats"/s,
    )
  })

  it("names a nested record by the path to it", async () => {
    const { base, head } = changedPair()
    const stats = { ...head.stats, effectPropagation: { sccCount: 0 } }
    const error = await refusalOf(base, { ...head, stats } as unknown as IR)
    expect(error.message).toContain("headIR.stats.effectPropagation:")
  })
})

describe("two Documents of different schemas", () => {
  it("are refused as schema-mismatch, naming the base schema", async () => {
    const base = makeIR()
    const head = makeIR({
      $schema: "https://aburi.kage1020.com/schema/aburi.ir.v2.json" as IR["$schema"],
    })
    expect(await refusalOf(base, head)).toMatchObject({
      code: "schema-mismatch",
      value: base.$schema,
    })
  })
})

describe("a Symbol missing a field", () => {
  it.each([
    "fingerprint",
    "source",
    "calls",
    "decorators",
    "effects",
    "rules",
    "id",
  ])("is refused by name when it lacks %s, which the diff reads", async (field) => {
    const { base } = changedPair()
    const error = await refusalOf(base, headWithoutSymbolField(field))
    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toContain("headIR.symbols[0]")
    expect(error.message).toContain(`"${field}" is absent`)
  })

  it.each([
    "visibility",
    "name",
    "kind",
    "language",
    "confidence",
    "derivedBy",
  ])("is refused when it lacks %s, although the diff never reads it", async (field) => {
    const { base } = changedPair()
    const error = await refusalOf(base, headWithoutSymbolField(field))
    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toContain(`"${field}"`)
  })

  it.each([
    "signature",
    "component",
  ])("is accepted without %s, which the schema makes optional", (field) => {
    const { base } = changedPair()
    expect(() => diffOf(base, headWithoutSymbolField(field))).not.toThrow()
  })
})

describe("a malformed entry", () => {
  const foo = () => makeSymbol({ id: "ts:src/a.ts#foo", name: "foo" })

  it.each<[string, Partial<IR>, string, string]>([
    ["a null Symbol", { symbols: [null as unknown as IRSymbol] }, "baseIR.symbols[0]", "null"],
    [
      "a null Component",
      { components: [null as unknown as Component] },
      "baseIR.components[0]",
      "null",
    ],
    [
      "a numeric Dependency",
      { dependencies: [7 as unknown as IR["dependencies"][number]] },
      "baseIR.dependencies[0]",
      "a number",
    ],
    [
      "a Symbol whose id is a number",
      { symbols: [{ ...foo(), id: 42 } as unknown as IRSymbol] },
      "baseIR.symbols[0]",
      '"id" is a number',
    ],
    [
      "a Symbol whose fingerprint is not an object",
      { symbols: [{ ...foo(), fingerprint: "aaa" } as unknown as IRSymbol] },
      "baseIR.symbols[0]",
      '"fingerprint"',
    ],
    [
      "a Symbol whose id is null",
      { symbols: [{ ...foo(), id: null } as unknown as IRSymbol] },
      "baseIR.symbols[0]",
      '"id" is null',
    ],
    [
      "a Dependency with no via",
      { dependencies: [{ from: "a", to: "b" } as unknown as IR["dependencies"][number]] },
      "baseIR.dependencies[0]",
      '"via" is absent',
    ],
    [
      "a Component with no roots",
      { components: [without(component({ id: "core", name: "core" }), "roots")] },
      "baseIR.components[0]",
      '"roots"',
    ],
  ])("names where it is for %s", async (_, overrides, subject, detail) => {
    const error = await refusalOf({ ...makeIR(), ...overrides }, makeIR())
    expect(error.code).toBe("ir-shape-invalid")
    expect(error.message).toContain(subject)
    expect(error.message).toContain(detail)
  })

  it("names the index it is at, not the first", async () => {
    const symbols = ["a", "b", "c", "d"].map((n) => makeSymbol({ id: `ts:src/${n}.ts#f`, name: n }))
    const broken = [...symbols.slice(0, 3), without(symbols[3] as IRSymbol, "source")]
    const error = await refusalOf(makeIR({ symbols }), makeIR({ symbols: broken }))
    expect(error.message).toContain("headIR.symbols[3]")
    expect(error.message).not.toContain("symbols[0]")
  })

  it("names baseIR when both sides are broken", async () => {
    const brokenSymbol = () => without(foo(), "source")
    const error = await refusalOf(
      makeIR({ symbols: [brokenSymbol()] }),
      makeIR({ symbols: [brokenSymbol()] }),
    )
    expect(error.message).toContain("baseIR")
    expect(error.message).not.toContain("headIR")
  })

  it("quotes one breach, counts the rest, and carries all of them with their side", async () => {
    const { base } = changedPair()
    const symbol = without(foo(), "source", "calls", "rules")
    const error = await refusalOf(base, { ...base, symbols: [symbol] })
    expect(error.message).toMatch(/"(source|calls|rules)" is absent/)
    expect(error.message).toContain("2 more")
    expect(error.violations?.map((v) => v.subject)).toEqual([
      "headIR.symbols[0]",
      "headIR.symbols[0]",
      "headIR.symbols[0]",
    ])
    expect(error.violations?.map((v) => v.message).join(" ")).toMatch(/"source"/)
  })
})

describe("the gate is the shape check, not the whole integrity checker", () => {
  it("diffs a Document whose symbols[] is out of sort order", () => {
    const unsorted = makeIR({
      symbols: [
        makeSymbol({ id: "ts:src/z.ts#f", name: "z" }),
        makeSymbol({ id: "ts:src/a.ts#f", name: "a" }),
      ],
    })
    expect(() => diffOf(unsorted, unsorted)).not.toThrow()
  })
})
