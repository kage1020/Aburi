import type { ScanResult } from "@aburi/core"
import { beforeAll, describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { irValidator } from "../src/ir-schema"
import { scanFixture } from "../src/scan-helper"

/**
 * Schema conformance for a scanned document, plus the two `workspace.languages` relations
 * the schema cannot state on its own: the field carries `LanguageId`s rather than plugin
 * manifest names, and it covers every `Symbol.language`.
 *
 * One checkout and one scan serve all three assertions — they mutate nothing.
 */

const fixture = useFixtureCheckout("nestjs-billing", "all")

let ir: ScanResult["ir"]
let violations: (doc: unknown) => string[]

beforeAll(async () => {
  violations = await irValidator()
  ir = (await scanFixture(fixture.root)).ir
})

describe("e2e: emitted IR validates against schema/aburi.ir.v1.json", () => {
  it("passes ajv for the nestjs-billing fixture", () => {
    expect(violations(ir)).toEqual([])
  })

  it("reports LanguageIds — not plugin manifest names — in workspace.languages", () => {
    expect(ir.workspace.languages).toEqual(["ts"])
    for (const id of ir.workspace.languages) expect(id).toMatch(/^[a-z][a-z0-9]*$/)
  })

  it("accepts a Decorator carrying a qualifier, and rejects the shapes Class B forbids", () => {
    // The fixture has no `import * as` and writes no qualified decorator, so nothing else in
    // the suite reaches the schema with a `qualifier` at all — in either direction. The key
    // is optional, `minLength: 1`, and of type string, which makes absent, `""` and `null`
    // three different answers the schema has to give.
    const decorated = ir.symbols.find((symbol) => symbol.decorators.length > 0)
    expect(decorated).toBeDefined()
    const withQualifier = (qualifier: unknown) => ({
      ...ir,
      symbols: ir.symbols.map((symbol) =>
        symbol === decorated
          ? {
              ...symbol,
              decorators: symbol.decorators.map((d, i) => (i === 0 ? { ...d, qualifier } : d)),
            }
          : symbol,
      ),
    })

    expect(violations(withQualifier("nest"))).toEqual([])
    expect(violations(withQualifier("")).length).toBeGreaterThan(0)
    expect(violations(withQualifier(null)).length).toBeGreaterThan(0)
  })

  it("keeps every Symbol.language inside workspace.languages", () => {
    const declared = new Set<string>(ir.workspace.languages)
    const used = new Set(ir.symbols.map((symbol) => symbol.language))
    expect(used.size).toBeGreaterThan(0)
    for (const language of used) expect(declared.has(language)).toBe(true)
  })
})
